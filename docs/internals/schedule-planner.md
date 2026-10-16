# Планировщик и квота (тикет 16)

Реализовано 8 октября 2026 года на synthetic state, без credentials и реальных
репозиториев. Контракт — решения 10/12 и state из 14. Планировщик не обслуживает
OAuth: стоимость startup, host refresh, публикации сессии и остановки дочернего
процесса входит в тот же общий прогноз **две Linux-минуты/job**. В пилоте 14 октября 2026
disabled jobs без account read длились 133–152 с, то есть 3 округлённые минуты:
прогноз занижен, запас покрывает его частично ([поддержка](../support.md)).
Отдельных частых auth jobs нет.

С тикета 37 окна будит внешний таймер ([ADR-0002](../adr/0002-external-timer.md)):
планировщик публикует скомпилированный cron в файл плана таймера, а в `on.schedule`
workflow остаётся только статический суточный резерв. Подробности — раздел
[«Внешний таймер и статический резерв»](#внешний-таймер-и-статический-резерв-тикет-37).

## Модули

- `src/schedule/schedule-time.mjs`: сетка 300 секунд с фазой `:02`, горизонт новых назначений 365 дней.
- `src/schedule/schedule-planner.mjs`: объединённые окна/слоты, компилятор UTC cron,
  развёртка реальных yearless-триггеров, admission всех периодов и durable reconcile.
- `src/schedule/schedule-state.mjs`: проверяемое расширение схемы 1, квотная пауза и guard consume.
- `src/schedule/managed-schedule.mjs`: ограниченный UTC cron (`expandCron`), формат плана
  таймера (`renderTimerPlan`/`readTimerPlan`) и чтение старого workflow region
  (`readManagedSchedule`) без Node-зависимостей; тот же разбор импортирует внешний
  таймер [`worker/`](../../worker/README.md) (тикет 36).
- `src/github/github-schedule.mjs`: Contents CAS файла плана на текущем default branch,
  проверка state version перед PUT, условное создание отсутствующего файла и
  exact-content readback. Workflow этот writer не меняет.
- `test/support/schedule-fixture.mjs`: GitHub REST fixture двух файлов default branch
  (workflow и план), SHA/отсутствие файла/отказы. Это не production workflow.
- `test/schedule-planner.test.mjs`: fake clock и planner → настоящий writer →
  synthetic REST → workflow fixtures. State/partial-select regression — также в
  `test/reset-cycles.test.mjs`.

## Расписание и границы

Планировщик берёт все текущие незавершённые выбранные циклы из authoritative
state. Начало runner-окна — `max(actualNow, scheduledAt, nextAttemptAt)`;
исключительная граница — сохранённая `deadline`. Пересекающиеся окна объединяются,
пользовательские минутные группы не изменяются. Неполное чтение metadata не
удаляет известные окна; eligibility перед consume остаётся у engine/account.
Disable/revoke убирают всё расписание. При reconnect или неизвестном consume
остаются только допустимые discovery/recovery; история запросов сохраняется.

Первая плановая точка — `120 + 300 * ceil((start - 120) / 300)`, точки строго
меньше deadline. Discovery — `2 0,4,8,12,16,20 * * *` UTC. Совпадающие точки
активных циклов исключаются из датированных cron, чтобы discovery не создавал
вторую job. Для каждого day/month часы объединяются только при одинаковых полных
множествах минут. Развёртка проверяет полночь, конец месяца, високосный день и год;
`10:57`/`11:02` не превращаются в четыре сочетания hour/minute.

Cron не содержит года. Прогноз разворачивает опубликованные выражения по
фактическим календарным датам, включая ранние/ежегодные no-op. Только актуальные
state, actual now, `nextAttemptAt`, ID/группа, deadline и quota admission разрешают
consume. Поздние runners не наверстывают пропущенное и не начинают новый час.
Отчёт показывает задержанное/пропущенное окно как проблему исполнения, без SLA.

Новые цели/автоматизация конечных сроков дальше 365 дней отклоняются в `select`
и при новом `apply-now`/`retry`; исходные сроки не обрезаются. Явное сохранение ID
с `automation:false` не публикует дальнюю автоматизацию. Reconcile уже принятых
циклов не переписывает их границы и не создаёт отложенную публикацию новых дальних
дат. Для Δ < 5 минут показывается предупреждение; отсутствие планового слота
отклоняет новое автоматическое назначение. Для **5–15 минут включительно** нужен
`acknowledgeDelayRisk:true` в команде select. Без слота можно сохранить ID без
автоматизации и отдельно выбрать «применить сейчас» в поддержанном горизонте.

Компилятор по умолчанию допускает **256 выражений**, параметр `maxExpressions`
принимает 1–4096. Это предел программы, а не установленный максимум GitHub.
Переполнение сохраняет Δ/выбор/границы, возвращает
`cron_compiler_limit_exceeded`, ставит consume на паузу и пытается оставить
бюджетное редкое recovery. Если recovery тоже не помещается, убирает всё
расписание и показывает ручной путь. Проекция ограничена 400 днями и 24 явно
заданными периодами, чтобы вместить горизонт и конец последнего billing period;
неподдержанные входы отклоняются явно. Валидация списков самим GitHub — 21.

## Вход квотного admission

`reconcile({quota, resume:false})` получает актуальную оценку от интеграции 17.
Нельзя подставлять checkout snapshot или выдавать локальный счётчик за точный
остаток владельца. Пример формы, все данные synthetic:

```js
const quota = {
  periods: [{
    start: 1791417600, end: 1794009600, // реальные границы billing period, не угаданный месяц
    usedMinutes: 0,                    // расход сервиса, включая уже стартовавшие jobs
    providerRemainingMinutes: null,   // неизвестный общий остаток, не нулевая стоимость
    paidUsageBlocked: true,           // явное подтверждение проверенной защиты от платного расхода
  }],
  queuedJobs: 0,                      // уже поставленные в очередь/rerun/dispatch jobs
  cleanupDelaySeconds: 300,           // предположение прогноза, не SLA очистки
};
```

Периоды должны быть непрерывными, первый включает actual now, последний покрывает
все активные окна. Для следующих периодов требуются явные данные; приложение не
выдумывает остаток allowance или границы billing. Отсутствующий/некорректный quota
ставит расписание на паузу. `paidUsageBlocked` подтверждает установленную
пользователем защиту провайдера; alert-only budget не является таким подтверждением.
Сам модуль billing не включает и административных настроек не меняет.
Известный остаток дополнительно ограничивает admission. Неизвестный остаток при
подтверждённой защите оставляет предупреждение `provider_quota_unknown`.

Для каждого периода прогноз:

```text
usedMinutes + 2 * (runnerJobs + fallbackJobs + pendingJobs) + 100 <= 1000
2 * (runnerJobs + fallbackJobs + pendingJobs) + 100 <= providerRemainingMinutes  // когда известен
```

`runnerJobs` считаются по скомпилированным выражениям плана, а не числу строк или
сбросов: каждый dispatch внешнего таймера — такая же оплачиваемая job, как
schedule run. `fallbackJobs` — запуски статического резерва `41 5 * * *` в
периоде; они есть в любом состоянии, включая паузу и disabled. `pendingJobs` включают queued jobs и все старые триггеры на ожидаемом
интервале очистки; совпадения со свежим расписанием консервативно учитываются
дополнительно. Queue не имеет гарантированного срока доставки, поэтому её
возможная стоимость закладывается в **каждый** supplied period. Это запас, а не
утверждение о повторном начислении одной job. Резерв 100 включает как минимум
две минуты на job остановки/reconcile и остаётся недоступен обычному discovery.
Пауза подготавливается при отказе прогноза, до исчерпания остатка.

30 дней пустой очереди: 180 discovery jobs + 30 резервных запусков, 420 минут +
резерв 100 = 520 (ADR-0002). Часовой цикл с midnight-start: 191 общий runner-слот
с дедупликацией + 30 резервных, 542 минуты.
24-часовой Δ с discovery обычно превышает 1000; окно остаётся в state с исходным
Δ, но активный cron не включается. Фактическое начисление округляет длительность
каждой job вверх; две минуты — предположение до пилота, не верхний предел OAuth.

## Пауза, reconcile и отказ публикации

Расширение `scheduler` добавляется к существующей схеме 1 при первом reconcile;
старые state/auth layouts и история сохраняются. В нём находятся `mode`, причина,
`admittedUntil`, desired hash/expressions/sourceVersion/projection, подтверждённый
workflow и последнее прочитанное расписание с его отдельным прогнозом.

1. Прочитать текущий план/default branch. При недоступности его стоимости
   нельзя считать нулевой: durable pause, publication unconfirmed, ручное восстановление.
   Отсутствующий файл — пустой план без proof (`observed: null`).
2. Из текущего state пересчитать admission. Сохранить квотную паузу и desired
   расписание **до** попытки менять план. На паузе убрать частые окна.
3. Оставить только датированные четырёхчасовые recovery-слоты, которые помещаются
   в каждый период с pending jobs, резервными запусками и резервом 100. При
   отсутствии бюджета план пуст; если не помещаются даже резервные запуски,
   добавляется `fallback_exceeds_quota`: остановить их может только отключение
   workflow в GitHub.
4. Проверить state version, актуальный default branch и SHA плана, выполнить
   условный PUT при изменении содержимого (отсутствующий файл создаётся PUT без
   SHA, даже пустым). Прочитать полное содержимое назад; потерянный ответ PUT
   подтверждается только точным совпадением. Зафиксировать confirmed
   hash/SHA/version. State и план не являются одной транзакцией.
5. Отказ оставляет publication unconfirmed. Отчёт отдельно показывает прогноз
   **последнего опубликованного расписания без очистки**, который может превышать
   бюджет, и желаемый уменьшенный прогноз. Поздняя queued job проверяет durable
   pause до резервирования и перед dispatch; consume не отправляется.
6. Reconcile после установки, чтения/discovery, команд, успеха и interruption
   восстанавливает окна из current state. Одинаковый workflow не получает повторный
   PUT; pending intent/успех и исходные границы переживают restart.

План — файл `.auto-reset-timer-plan.json` на default branch, одна каноническая
JSON-строка:

```json
{"schema":1,"expressions":["2 0,4,8,12,16,20 * * *","7,12,17 10 14 10 *"]}
```

Writer и Worker поддерживают только собственный UTC dialect
minute/hour/day/month/`*`; любая другая сериализация тех же выражений, лишние поля
или другой `schema` отклоняются. Все сетевые операции
используют существующий single-PAT `GitHubStorage`; production stream обязан
сериализовать state/workflow writers. Contents CAS не заменяет эту сериализацию.

`resume:true` — явный новый admission с актуальным quota; обычный reconcile не
снимает квотную паузу. Новые select/apply-now/retry/resume инвалидируют ранее
активный admission. Consume запрещён при needsAdmission/paused и после
`admittedUntil`, включая финальную проверку перед отправкой. Старый engine без
расширения scheduler остаётся локальным synthetic seam 14; production 17 обязан
инициализировать planner и выполнить новый admission **до** consume.

`dueCycleIds` возвращаются только после подтверждённой публикации и успешного
admission. Это подсказка общему runner/dispatch пути 17 при due-now, не отправка
запроса и не утверждение об успешной попытке. Reconcile нужно вызывать с новым
расходом перед каждым runner; ручные jobs, startup/auth и текущая job должны быть
учтены интеграцией. Ожидание в runner и `if` внутри начавшейся job не экономят запуск.

## Проверка и оставшиеся границы

`npm test`: **171 passed, 8 skipped**; 26 planner fixtures и 3 новые metadata
regressions включены в общий suite. `npm run test:contract`: **18/18 passed** на
stock App Server 0.160.1 с isolated HOME и OS network guard, synthetic backend.
Проверены будущие окна, короткий/длинный Δ, даты, несколько групп, отсутствие
очереди, missed/late runs, quota pause, cleanup failure, interrupted reconcile,
возобновление без нового часа, version/SHA/default branch, lost PUT и отсутствие
повторного consume. Нет доступа к настоящим GitHub/OAuth/account credentials.

Локальная оценка не гарантирует hard billing ceiling: queued jobs, непредсказуемая
задержка очистки, прочие workflows и расходы сверх прогноза могут его превысить.
При невозможности запустить даже recovery нужен ручной путь. Интеграция общего
writer/CLI/host lifecycle, финальная проверка после OAuth/startup и Linux smoke —
17; installer/подтверждение защиты — 18; реальная доставка, billing, размеры
schedule и серверные свойства — 21. Тикет 16 не включает живую установку.

## Интеграция 17

[Private workflow](private-workflow.md) выполняет admission/reconcile до account
и cleanup после результата/ошибки, в том же installation writer stream.
Fresh quota receipt старше 300 секунд становится quota unavailable; invalid/stale
budget не считается вечным допуском. Реальный provider/billing/protection — 18/21.
Общий stand подтвердил removal/unconfirmed cleanup и late consume guard;
209 offline и 24 stock synthetic checks прошли на macOS и Linux x64.

## Внешний таймер и статический резерв (тикет 37)

Реализовано 14 октября 2026 года offline, production не обновлялся.

**Где план.** Отдельный файл `.auto-reset-timer-plan.json` на default branch, а не
managed region внутри workflow. Оба варианта дают Worker только Contents: read, но
файл вне `.github/workflows/`:

- правка плана не меняет workflow, поэтому не создаёт свежую регистрацию cron и не
  может породить нативные дубли окон;
- повседневная работа пишет только Contents: основному PAT `Workflows: write`
  нужен лишь для bootstrap и явного Upgrade (отмечено для установщика 38);
- default-branch CAS/readback из 16 сохранён: SHA плана, проверка state version
  перед PUT, точное чтение назад, условное создание отсутствующего файла.

Bootstrap публикует пустой план вместе с workflow и marker. Worker на отсутствующем
файле fail-closed (`github_not_found`), поэтому planner создаёт пустой план и при
первом reconcile после Upgrade со старого pin.

**Статический резерв.** Шаблон содержит единственный cron `41 5 * * *`
(`FALLBACK_CRON`): раз в сутки, вне сетки таймера `:02`/5 и вне начала часа.
Planner его не переписывает. Резервный запуск (`event=schedule`) выполняет только
reconcile и проверку таймера: без account read, refresh и плановой попытки;
pilot gate пропускает его как status. Каждый пустой `workflow_dispatch`
записывает `scheduler.wokenAt`; status и sealed команды тиком не считаются.
Каждая новая подтверждённая публикация плана записывает `scheduler.planSince`.
Резерв ищет последний слот плана, который не моложе 30 минут
(`TIMER_GRACE_SECONDS`) и не раньше `planSince`; если после него не было пустого
dispatch, Summary получает строку о Worker, stdout — `timerProblem:
"external_timer_stale"`, job завершается с ошибкой (это единственное уведомление
об остановке таймера). В активном окне это «нет тика 30 минут», вне окон — пропуск
последнего discovery. Проверка смотрит план, действовавший до reconcile этого
запуска. Ложная тревога возможна, если в нужный слот уже стартовал другой run
(status/admin), а Worker вернул `duplicate`.

**Проба таймера (тикет 38).** Admin-команда `timer` установщика сохраняет
`installation.timer = { expiresAt, probeAt, confirmedAt }`; `probeAt` — первый слот
сетки не раньше чем через 15 минут (`TIMER_PROBE_LEAD_SECONDS`). Пока установка на
паузе (не revoked), проба не подтверждена и слот не закончился (`probeAt + 5 мин`),
`pendingProbe` делает её единственным выражением плана. Пустой dispatch, стартовавший
в `[probeAt, probeAt + 30 мин)`, записывает `confirmedAt` (`probeConfirmed`);
следующий reconcile убирает пробу. Pause/Upgrade/Uninstall отменяют неподтверждённую
пробу до своей очистки, uninstall удаляет запись о таймере. Enable без `confirmedAt`
отказывает (`timer_confirmation_required`); срок таймера не проверяется — у приложения
таймера (тикет 42) его нет.

**Admission и прогноз.** discovery + окна (каждый dispatch таймера — job) +
`fallbackJobs` в каждом периоде + reserve 100; то же добавлено в
`admitObserverQuota`. Предупреждения: `delivery_has_no_sla` сохраняется (ни
Cloudflare, ни dispatch не дают SLA), новое `windows_need_external_timer`
(окна без таймера не запускаются), `fallback_exceeds_quota` на паузе. Квотная
пауза по-прежнему сначала durable, затем убирает частые окна из плана; резерв
продолжает работать и учтён в recovery.

**Upgrade существующей установки.** Upgrade выполняет код старого pin: disable,
снятие managed cron через его writer, публикация нового шаблона из целевого
commit и readback через его `readManagedSchedule`. Поэтому новый шаблон сохраняет
маркеры `auto-reset:schedule:*`, а резервный cron стоит внутри них: старый reader
читает `['41 5 * * *']`, и readback проходит. Новый допуск writer требует точного
шаблона: оставшийся managed cron → `untrusted_private_workflow` до записи state.
Upgrade новым кодом заменяет весь файл, поэтому managed cron исчезает вместе со
старым содержимым. State не мигрирует: `requests`, `groups`, `cycles`, `commands`,
auth и pending operation остаются; старые proof workflow в `scheduler` и forecast
без `fallbackJobs` валидны. Uninstall в конце отключает workflow, чтобы резервный
cron не запускал failing jobs без PAT Secret.

Проверка: `test/schedule-planner.test.mjs`, `test/private-workflow.test.mjs`,
`test/installer.test.mjs`, `test/timer-worker.test.mjs`; межверсионный прогон
(код до 37 выполняет Upgrade в новый шаблон, новый planner продолжает) описан в
Answer тикета 37.
