# Приватный workflow и общий writer

Тикет 17 объединяет GitHub storage, host-owned OAuth, external-token App Server,
CycleEngine и SchedulePlanner. Реальные OAuth/account/grant/billing свойства, таймер и
revoke проверены в пилоте 21 ([границы](support.md)); установка и uninstall — 18.

## Поставка и допуск

`templates/private-auto-reset.yml` — шаблон для `.github/workflows/auto-reset.yml`
в личном private repo. `renderPrivateWorkflow(programCommit)` требует полный
40-символьный SHA программы, находящейся в том же private repo. Checkout читает
именно этот commit; event SHA, input и state branch не выбирают исполняемую программу.
Обновление pins — явная операция установщика, не checkout нового default branch.

В шаблоне нет credentials, а единственный cron — статический суточный резерв
`41 5 * * *` (тикет 37). Окна планировщик публикует не в workflow, а в файл плана
внешнего таймера; workflow меняет только явный Upgrade. Actions checkout/setup-node закреплены полными SHA; Node 26.10.0,
App Server 0.160.1 Linux x64 с SHA256 из `runtime-lock.json`, OS prerequisite
`bubblewrap` и штатный AppArmor профиль, npm lockfile и
`--ignore-scripts` сохраняются. Runner — ubuntu-24.04; один job, permissions
`contents: read`; PAT получает только шаг программы. Checkout credentials не
сохраняются, cache/upload artifacts отсутствуют.

`scripts/install-linux-prerequisites.sh` устанавливает signed Ubuntu packages
`bubblewrap`, `apparmor`, `apparmor-profiles`, `apparmor-utils`. На Ubuntu 24.04
при отсутствии загруженного профиля копирует штатный extra profile bubblewrap
в `/etc/apparmor.d/` и загружает его через parser; существующий файл не перезаписывает.
Проверяет точный startup probe stock App Server под непривилегированным runner user.
Глобальные user namespace ограничения и `configWarning` guard сохраняются.
Основание — [официальная инструкция](https://learn.chatgpt.com/docs/sandboxing)
и [границы hosted проверки](support.md).

`src/private-cli.mjs` отказывает до чтения auth, для обычной работы/consume, пока
`AUTO_RESET_PILOT_APPROVED` не равен выбранному `GITHUB_REPOSITORY`. Значение не
поставляется: установщик его не создаёт, владелец задаёт repository variable сам. Disabled admin auth/read, status,
резервный запуск (`event=schedule`, только reconcile) и пустой dispatch внешнего таймера
допускаются без успешного consume-пилота. Без допуска пустой dispatch выполняет только
reconcile, отметку `wokenAt` и подтверждение пробного слота установщика (тикет 38) —
account read и попытка не выполняются даже у включённой установки.
Открытие gate — решение владельца о живом enable/consume; закрытый gate не превращает synthetic проверки в живое разрешение.

Допуск writer проверяет через REST private repository, default branch, событие
schedule/workflow_dispatch, текущий in-progress run, его repository/head branch/path
и точный trusted workflow из run.head_sha: содержимое должно совпасть с шаблоном
байт в байт. Managed cron, оставшийся от pin до тикета 37, PR/fork/другая
ветка/изменённый concurrency или код шага отказывают до state/Secret writes. Код из public source repo может
выполнять только `.github/workflows/offline-linux.yml` без account credentials.

## Сериализация и команды

Scheduled, manual и будущий setup/admin поток используют одну группу
`auto-reset-installation-writer`, `cancel-in-progress: false`, `queue: max`.
GitHub допускает 100 pending runs; при переполнении новый run отменяется.
Порядок определяется ожиданием concurrency, не dispatch time. Это транспорт,
а не durable очередь команд. По умолчанию `queue: single` заменяет pending run;
оба случая воспроизведены в стенде.

Единственная точка durable acceptance — существующий journal `state.commands`
из CycleEngine: command ID, fingerprint, expectedVersion и accepted result после
CAS/readback. HTTP dispatch, pending/cancelled run и отсутствие Summary не являются
принятием. Отменённая/непопавшая в journal команда остаётся **неподтверждённой**.
Для повторной доставки нужен тот же ID и то же содержимое; новая версия/содержание
требуют новой команды. При version conflict получить свежий status, затем явно
сформировать новую команду. Duplicate receipt не повторяет control action и не
повторяет quota resume.

Actions input `command` — JSON до 60 000 bytes, передаваемый только через env,
без подстановки в shell. `readDispatchCommand` (`src/installer-admin.mjs`) до
допуска writer, чтения state и account RPC принимает ровно три формы:

```json
""
{"command":"status"}
{"command":"admin","commandId":"disable-001","expectedVersion":42,"action":"control","envelope":"<AES-256-GCM>"}
```

Пустой input — обычный reconcile/run, status — только чтение, остальные admin
actions раскрывает `runInstallerAdmin` внутри writer slot. Открытая команда
(`{"command":"control",…}`, status с лишними полями, любая другая) отклоняется как
`open_command_rejected` без изменения state и без consume (тикет 34). Причина:
приложение внешнего таймера ([ADR-0002](adr/0002-external-timer.md),
[ADR-0003](adr/0003-single-token-timer-app.md)) имеет Actions: write и может отправить
dispatch с любым input, но не знает токен установки. Таймер
запускает тот же `auto-reset.yml` с пустым input; отдельного workflow без inputs
нет, поэтому проверка `run.path === WORKFLOW_PATH` в `acquireGitHubWriter` не
меняется. В шаблоне изменено только описание input; оно входит в trusted
workflow, поэтому production принимает новый код только после явного Upgrade.

Admin action `control` шифруется `sealAdmin` ключом из основного PAT; AAD
связывает repository, `commandId`, `expectedVersion` и `action`. Payload — поля
control без `command`/`commandId`/`expectedVersion`, например `{"action":"disable"}`.
Раскрытая команда получает ID и версию из заголовка и идёт прежним путём
CycleEngine: тот же journal, fingerprint полей, CAS, duplicate и правило resume.
Подделанный, чужой repository/token или изменённый заголовок →
`invalid_admin_command` до writer. Повтор того же ID и тех же полей, даже с новым
ciphertext, — `duplicate:true`; другие поля под тем же ID — `command_id_reused`.
Pilot gate применяется к раскрытому control как к обычной работе. Повтор
перехваченного ciphertext равен повторной доставке той же команды.

Принятые до тикета 34 открытые control-команды остаются в `state.commands`:
миграция не нужна, история не теряется. Повторная доставка их ID теперь
возможна только тем же содержимым в sealed control и даёт duplicate, без
повторного действия и quota resume. Открытая команда в run на старом pin, который
стартует после Upgrade, получает `program_version_conflict` до runPrivateJob и
остаётся неподтверждённой. Её можно доставить заново как sealed control со
свежей версией. Установщик 18 открытый control никогда не отправлял.

Control fields/actions определены в `docs/reset-cycle-state.md`. Status не вызывает
account RPC/consume. Summary использует язык authoritative state; командные ошибки
до чтения state — `AUTO_RESET_LANGUAGE` (ru/en). В stdout только machine version/state/error и фиксированные сообщения;
произвольные command payloads и backend exceptions не выводятся.

`withInstallationWriter(serialization, work)` — общий seam для 18.
[Установщик 18](installation.md) доставляет encrypted одноразовые admin-команды через dispatch.
Локальный установщик сам не владеет GitHub slot: его действия должны исполняться
в этом потоке после dispatch/acquireGitHubWriter. Нельзя создавать независимый
локальный writer или обновлять state/Secret одновременно с runner. Проверки
создания установки/seed/uninstall на fake clients выполняются в 18, без зависимости
17 от завершения 18. Как передать seed/setup work в тот же поток — часть 18;
interactive login не добавляется в schedule path.

## Account/auth и финальная отправка

`HostAccountAdapter` сохраняет eligibility/outcome parser AccountAdapter, но
связывает `HostAuthSession.reserveConsume` с **новой** durable reservation engine.
Одноразовый current-job proof нельзя создать из старого unknown journal.
Данные state/auth читаются через GitHubStorage после writer slot; checkout state
и Secret snapshot сами по себе не подтверждают актуальность сессии.

После reservation host выполняет OAuth при необходимости: intent/readback →
refresh → atomic owned local vault → target/readback → Secret PUT → finalize/readback.
Только затем запускается App Server с чистым HOME/CODEX_HOME и external login.
Refresh/id tokens и PAT не передаются child. Временный vault не является artifact;
owned процессы закрываются до удаления runtime homes, host vault удаляется в finally.

Новый `finalDispatch` выполняется после startup и последнего асинхронного auth
read/check. Engine внутри свежего inspect сравнивает exact version, durable
request ID/credit ID/key, current cycle, disable/revoke, quota и original deadline.
Допускается только отсутствие version transition либо ровно три собственные auth
версии (intent/target/finalize), подтверждённые текущим HostAuthSession. Чужая
команда/поздний startup не разрешают send. Guard и начало actual RPC находятся в
одном синхронном turn; отправленный RPC не отменяется новой командой.

`onResponse` сохраняет полученный ответ в текущем adapter до cleanup. Даже если
cleanup/read затем откажут, parser подтверждённого consume возвращает тот же outcome
для durable записи engine. Journal сохраняется до следующего account read.
Crash до записи ответа оставляет unknown и останавливает любые новые ID/keys,
retry и consume после reconnect. Server replay/idempotency contract не доказан:
сетевой повтор не предоставлен. External refresh request получает fixed refusal,
401/refresh failure останавливают текущий interval без hidden replay; следующая
job обслуживает auth только при отсутствии unknown consume.

## Расписание и квота

До consume выполняется planner admission/reconcile, после результата или ошибки —
повторный reconcile для cleanup. При quota pause durable запрет опережает удаление
частых окон из плана таймера. Если нет бюджета на discovery, план пуст. Failed PUT
остаётся `unconfirmed`, сохраняет последний прочитанный план, прогноз расхода
и явное сообщение в Summary; late/queued jobs не могут consume через paused guard.
State branch write и PUT плана не запускают account workflow повторно: push и
repository_dispatch triggers отсутствуют.

При настроенной `AUTO_RESET_BILLING_POLICY` CLI перед каждой обычной job и admin enable
получает свежую квоту через [GitHub provider](github-billing.md), читая billing тем же
`AUTO_RESET_GITHUB_TOKEN` (Plan: read, тикет 40); отдельного billing Secret нет. Policy сохраняет проверенные
при установке owner/repo, plan и account-wide Actions budget `$0 + Stop usage`.
Изменение бюджета требует повторной проверки: personal budget не читается API.
Provider соединяет месячный account-wide usage с полной историей собственных jobs
и резервирует текущие/queued jobs. Его отказ запрещает fallback к cached receipt.
Этот путь проверен в private Actions job пилота 21 без account RPC/consume.

Для установок без provider CLI принимает `AUTO_RESET_QUOTA_RECEIPT` как JSON:
`{"observedAt": <unix seconds>, "quota": <контракт SchedulePlanner>}`.
Receipt старше 300 секунд/из будущего/невалидный становится quota unavailable и
отключает расписание. Однократный cached расход не даёт автономного допуска.
Final dispatch также проверяет срок receipt после асинхронного startup/refresh.

Если итоговый scheduler не подтвердил публикацию, job возвращает его конкретную
ошибку либо `schedule_publication_unconfirmed` для pending состояния без ошибки.
`problem: null` больше не сопровождает такой отказ; ранее установленная ошибка
auth/storage/consume сохраняет приоритет. Подтверждённый quota pause сам по себе
не становится ошибкой выполнения.

## Внешний таймер и резервный запуск

С тикета 37 ([ADR-0002](adr/0002-external-timer.md)) окна будит Worker Cloudflare
([`worker/`](../worker/README.md)): на каждом тике он читает
`.auto-reset-timer-plan.json` на `main` и в минуты плана отправляет пустой
`workflow_dispatch`. Пустой input — обычный reconcile/run, поэтому повтор,
`nextAttemptAt`, граница и quota guard работают как раньше; поздний или двойной
тик безвреден. Run пустого dispatch записывает `scheduler.wokenAt` (status и
sealed команды — нет).

`on.schedule` содержит только `41 5 * * *`. Такой run (`event=schedule`) —
резервный запуск: `runPrivateJob({ event: 'schedule' })` выполняет reconcile
и cleanup, но не читает account и не делает плановую попытку, даже если цикл
уже due. До reconcile он сверяет `wokenAt` с последним слотом действовавшего
плана старше 30 минут; при отставании Summary получает строку «Резервный запуск:
внешний таймер не будил установку…», stdout — `timerProblem:
"external_timer_stale"`, exit code 1. Правила и границы проверки —
[планировщик](schedule-planner.md#внешний-таймер-и-статический-резерв-тикет-37).

Резервный cron никогда не переписывается, поэтому окна не зависят от свежей
регистрации расписания. Он запускается и на паузе (1 job в сутки, учтён в
admission). Uninstall после удаления Secrets отключает workflow
(`PUT /actions/workflows/auto-reset.yml/disable`, PAT ещё в памяти job),
иначе резерв запускал бы failing jobs без PAT.

Upgrade существующей установки выполняет код старого pin: он снимает managed
cron, публикует новый шаблон и читает его назад своим `readManagedSchedule`;
маркеры region в шаблоне сохранены ради этого readback. Первый запуск нового pin
создаёт пустой план; history, journal команд, unknown requests и pending
operation не мигрируют и сохраняются.

## Проверка

Общий стенд `testing/private-workflow-fixture.mjs` переиспользует fake GitHub с
настоящим LibSodium, host OAuth/local vault fixtures, account metadata parser,
state journals и Contents schedule writer. FakeActions выдаёт одно capability
всему job/setup/admin; проигравший writer не может писать state/Secret.

Воспроизведение и границы evidence:
[таблице поддержки](support.md).

Encrypted installer `check` accepts `forceRefresh: true` for an explicit disabled
host OAuth/publication probe; ordinary checks retain their normal expiry policy.
An explicit `select.selection.attemptUntil` may shorten the cycle's attempt window
for a bounded pilot. It cannot extend the original deadline or credit expiry;
metadata, reconnect and apply-now preserve this shorter cap. Omitting it retains
the normal cycle ending at expiry.
