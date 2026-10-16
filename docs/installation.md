# Установка на macOS

Тикет 18 реализует терминальный установщик и serialized admin-поток.
Реальные вход, private repo, billing, внешний таймер и revoke проверены в личном
пилоте 14 октября 2026; границы — в [таблице поддержки](support.md). Offline-тесты не создают repo, Secrets или настоящую сессию.

## Запуск

Нужны macOS, Node **26.10.0** и официальный локальный Codex **0.160.1** для
отдельного входа. Путь к binary задаётся на экране входа; seam 23 проверяет версию.
Установщик не импортирует credentials desktop и не принимает API key вместо ChatGPT.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run install:macos
```

Первый экран — `Русский (ru) / English (en)`. При TTY есть цветные этапы и таблицы;
без TTY — обычный текст без ANSI и echo токена. Plain input читается построчно.
Выбор и exact pending command сохраняются атомарно в 0600
`~/.config/auto-reset/installer.json`. `AUTO_RESET_INSTALLER_JOURNAL` позволяет задать
отдельный journal для другой установки. Токен установки в journal не попадает: он хранится
в macOS Keychain (раздел «Токен установки»), и повторный запуск его не спрашивает. Pending seed
хранится только в зашифрованном envelope.
Язык durable state/Actions Summary меняется через тот же writer.

**Мастер настройки (`i`).** После языка, repo и токена установки установщик сам проводит
по шагам ниже подряд: `1` Install → вход ChatGPT (`2`, при отзыве/reconnect `3`, затем `4`) →
квота (`q`, `b`) → внешний таймер (`c`, с ожиданием пробы). Перед каждым шагом: Enter — выполнить,
`0` — в меню. Выполненность шагов читается из state, поэтому прерванный мастер (выход, сбой шага,
незавершённая команда — её сначала доводит Resume) продолжает с первого невыполненного шага при
следующем запуске или по `i` в меню; непросроченную пробу таймера он снова ждёт, просроченную —
предлагает повторить `c`. Мастер запускается сам, только пока установка на паузе (или ещё не
создана) и шаг не выполнен. Итог — «настройка завершена»: правила (`m`, `w`, `5`) и включение `6`
с gate `AUTO_RESET_PILOT_APPROVED` остаются вашим отдельным решением. Все пункты меню ниже
доступны и вручную.

1. Создайте отдельный **private** repo с README. Установщик принимает только новый repo
   с README/LICENSE/.gitignore, чтобы не перезаписать пользовательский проект.
2. Выпустите **токен установки** — единственный токен, который вы создаёте сами
   ([ADR-0003](adr/0003-single-token-timer-app.md)). Оставьте ввод токена пустым:
   установщик откроет предзаполненную форму GitHub с именем, сроком 366 дней и правами
   **Contents, Secrets, Actions, Variables, Workflows — write** и **Plan: read**. В форме
   выберите repo и нажмите Generate, затем вставьте токен (ввод скрыт). Подробности и
   проверки — раздел «Токен установки». Токен хранится в `AUTO_RESET_GITHUB_TOKEN` и
   обслуживает setup, последующие jobs и чтение billing. Administration scope не нужен.
   Внешнему таймеру нужен **второй**, узкий токен (раздел «Внешний таймер»); токен
   установки третьей стороне не передаётся.
3. `1 Install` атомарно публикует программный commit, marker, workflow со статическим
   резервным cron `41 5 * * *` и пустой план таймера `.auto-reset-timer-plan.json`;
   затем dispatch `init` создаёт disabled state в `auto-reset-state` внутри writer.
4. `2 Login/reconnect` запускает официальный login с новым HOME/CODEX_HOME и чистым env.
   Executor ждёт завершения родителя и owned process group перед import/cleanup.
   Refresh token остаётся у host-программы; runner App Server получает только access token.
5. `3 Confirm new login` отдельно снимает reconnect/revoked после нового проверенного seed.
   `4 Check` читает account и metadata, оставаясь disabled. Consume запрещён.
6. `5 Select` показывает ID/status/type/expiry, предлагает Δ (по умолчанию час),
   предупреждает о Δ < 5 минут и предлагает явное начало для неизвестного/бессрочного срока.
   Неполный список не допускает auto-select; пустые metadata не подменяются сбросом.
7. `c Внешний таймер` разворачивает Cloudflare Worker и подтверждает его пробным пустым
   dispatch (раздел ниже). Без подтверждённого таймера enable отказывает с
   `timer_confirmation_required`; срока у приложения таймера нет, enable его не проверяет.
   `6 Enable/resume` требует gate живого consume — repository variable
   `AUTO_RESET_PILOT_APPROVED` со значением `owner/repo`; установщик её не создаёт, владелец
   задаёт её сам (Settings → Secrets and variables → Actions → Variables) после чтения
   [таблицы поддержки](support.md). Также нужны подтверждённые client path/persistence/cost policy,
   новая проверка подключения, подтверждённый таймер и свежий quota admission. Настроенный provider
   получает receipt непосредственно в runner, а не из ручного ввода.
8. `m Монитор` — встроенный интерактивный экран в обычном потоке терминала (без
   альтернативного экрана; без TTY печатается один снимок). «Выданные сбросы» — последний
   прочитанный список с датами истечения и состоянием цикла; «Общие правила» — две галочки
   для всех сбросов: «за 30 минут до истечения» (без условия недельной квоты) и
   «автоматически при исчерпании недельной квоты» (сброс с ближайшим сроком сразу после
   подтверждённого исчерпания; при 99% таймер учащает проверки на час). `↑↓` выбор,
   `Enter` — «Применить сейчас» с подтверждением `y` (цикл попыток с текущего момента,
   без условий правил) или вход в блок правил, `Enter`/`Space` — отметить, `Esc` — выйти,
   `2` — статус и журнал, `r` — обновить/проверить неподтверждённую команду, `q` — в меню.
   Команды монитора идут зашифрованным control и не требуют паузы; «Применить сейчас»
   требует включённой установки. Принятие команды не означает применение.
9. Сначала `7 Pause`, затем `w Weekly auto reset` включает/выключает сохраняемую опцию автоприменения **только
   при исчерпании недельной квоты** до её обычного обновления (resetsAt). Опция
   выключена по умолчанию, миграция её не включает; расписание включается отдельно
   (`6 Enable/resume`). Программа сама подтверждает недельное исчерпание через
   account RPC перед каждой попыткой: только пятичасовое исчерпание, неизвестное
   или устаревшее недельное окно применение не запускают.

На экране выбора указаны discovery раз в четыре часа, попытки раз в пять минут по
внешнему таймеру, суточный резервный запуск, горизонт 365 дней, лимит 1000 минут и
резерв 100. Ни Cloudflare, ни GitHub не обещают пунктуальность: запуск может задержаться
или не случиться.
Actions и Job Summary остаются интерфейсом последующего управления.

Перед enable подтвердите account-wide Actions budget **$0**, **Stop usage: Yes**,
владелец и Free/Pro plan. Сохранённая `AUTO_RESET_BILLING_POLICY` содержит schema1,
repository, budget0, stopUsagetrue, verifiedAt и plan. Budget не проверяется personal
API автоматически: после изменения бюджета нужна повторная проверка установки.
Меню `q Настроить квоту` сохраняет эти настройки через общий Actions writer;
`b Проверить квоту` проверяет сохранённые настройки в новой job.
[Контракт provider и ограничения](internals/github-billing.md).

До реальных setup/read probes владелец проверяет стоимость всего периода,
включая setup, другие jobs и queued jobs. Статический `AUTO_RESET_QUOTA_RECEIPT` repo
variable истекает через 300 секунд: это **не** постоянный unattended provider.
При настроенном provider расход читается перед каждой job; его ошибка останавливает
admission, ручной receipt её не обходит. Неизвестный остаток не считается нулевым.

## Внешний таймер

GitHub не обещает доставку `on: schedule` ни по задержке, ни по доле; в наших когортах
9–10 октября 2026 за время наблюдения не пришёл ни один из 39 слотов. Поэтому окна попыток будит внешний таймер
([ADR-0002](adr/0002-external-timer.md)): Cloudflare Worker на бесплатном плане тикает
раз в пять минут (`2-57/5 * * * *`), читает план `.auto-reset-timer-plan.json` на `main`
и только в его минуты отправляет пустой `workflow_dispatch` без inputs. Решение о
применении, повтор, граница и запрет раннего consume остаются в private workflow;
поздний или двойной тик даёт обычный reconcile. Нативный cron — только суточный резерв:
он сообщает в Summary (`external_timer_stale`), если таймер давно не будил установку.

Шаг `c Внешний таймер` выполняется на паузе. Доступ к GitHub Worker получает через
**приложение таймера** — GitHub App в аккаунте пользователя
([ADR-0003](adr/0003-single-token-timer-app.md)); токенов копировать не нужно, от
пользователя — два клика в GitHub:

1. Создайте бесплатный аккаунт Cloudflare (Workers Free). Платные функции не нужны:
   288 вызовов в сутки намного ниже лимитов Free.
2. **Create.** Установщик поднимает локальную страницу на `127.0.0.1` со случайным портом
   и открывает её в браузере; она сразу отправляет в GitHub manifest приложения
   (`auto-reset-timer-<6 hex>`, права **Actions: write** и **Contents: read**, webhook
   выключен — URL-заглушка `https://example.invalid/…` с `active: false`). Нажмите
   **Create GitHub App**: GitHub вернёт браузер на локальную страницу с одноразовым кодом,
   установщик проверяет `state` и в течение часа обменивает код на ключ приложения.
   Локальный сервер закрывается сразу после обмена или через 15 минут ожидания. Если в
   браузере открыт другой аккаунт GitHub, шаг останавливается (`timer_app_owner_mismatch`)
   и показывает ссылку для удаления созданного там приложения.
3. **Install.** Установщик открывает ссылку установки. Ссылка repo не предвыбирает:
   выберите **Only select repositories** → repo установки и нажмите **Install**, затем
   ответьте YES. Установщик находит installation ID запросом
   `GET /repos/{owner}/{repo}/installation` с JWT приложения; пока установки нет — просит
   установить и спрашивает снова. Установку на все repo установщик **показывает
   предупреждением и продолжает**: Worker сужает каждый токен до repo установки, но
   утечка ключа открыла бы все repo (см. ниже).
4. Установщик выпускает тот же узкий installation token, что и Worker, читает им repo и
   план — repo приватный и совпадает, default branch `main` — и сразу отзывает токен.
5. Развёртывание: `npx --yes wrangler@4.139.0 deploy` с `--var` `REPOSITORY`,
   `TIMER_APP_ID`, `TIMER_INSTALLATION_ID` (Wrangler откроет вход в Cloudflare в браузере;
   без браузера подойдёт `CLOUDFLARE_API_TOKEN`), затем `secret put TIMER_APP_KEY`. Если
   Wrangler упал, установщик предлагает повтор, пока ключ ещё в памяти. Код Worker
   импортирует общие модули из `src/`; редактор Dashboard такие импорты не собирает,
   поэтому код всегда загружает Wrangler.
6. Admin-команда `timer` получает только App ID, slug и installation ID. Writer
   сохраняет их в `installation.timer`, назначает пробный слот на сетке таймера через
   15–20 минут (изменение Cron Trigger распространяется до 15 минут) и публикует план из
   одной этой минуты.
7. Worker в пробный слот отправляет пустой dispatch; запуск виден в Actions. Этот запуск,
   стартовав в течение 30 минут после слота, отмечает таймер подтверждённым и убирает
   пробу из плана. Установщик ждёт и показывает итог; выйти можно в любой момент,
   результат виден в `s`. Пока gate `AUTO_RESET_PILOT_APPROVED` закрыт, пустой dispatch выполняет только
   reconcile и подтверждение пробы, без account read — как резервный запуск.
8. Если проба не подтвердилась, проверьте лог Worker
   (`npx --yes wrangler@4.139.0 tail --config src/worker/wrangler.toml`), secret
   `TIMER_APP_KEY` и установку приложения и повторите `c`: каждый повтор создаёт новое
   приложение и назначает новый слот; прежнее удалите по ссылке, которую покажет
   установщик. Пауза отменяет неподтверждённую пробу.

Если шаг остановился после Create, приложение остаётся в GitHub: установщик печатает
ссылку `https://github.com/settings/apps/<slug>/advanced` → **Delete GitHub App**.

`s Состояние` показывает `timer` (confirmed / probe / setup required),
`lastExternalWake` — начало последнего пустого dispatch — и `timerApp` (slug и
installation ID). Срока, напоминания и ротации у таймера нет.

### Переход с токена таймера

Установка, настроенная до тикета 42, работает на fine-grained PAT в secret `TIMER_TOKEN`;
`s` показывает `timerApp: timer token until … (c)`, а установщик при запуске и в `s`
напоминает о переходе. Порядок: `7 Pause` → `c` → `6`. Повтор `c` записывает
`TIMER_APP_KEY` и новые vars, удаляет secret `TIMER_TOKEN` (Wrangler спросит
подтверждение; при отказе установщик покажет команду ручного удаления), а writer
заменяет запись о таймере целиком — срок токена из state исчезает — и назначает новую
пробу. После подтверждения пробы отзовите прежний токен таймера в GitHub. До перехода
таймер продолжает работать на токене: enable срок не проверяет, а истёкший токен
заметит резервный запуск (`external_timer_stale`).

### Сторонний сервис и хранение ключа

Cloudflare — сторонний сервис вне GitHub, и у пользователя появляется его аккаунт.
**Ключ таймера** — закрытый ключ приложения — хранится только как зашифрованный Worker
secret `TIMER_APP_KEY` (PKCS#8 одной строкой base64): после записи его не показывают ни
Wrangler, ни Dashboard. GitHub выдаёт ключ в PKCS#1; установщик переводит его в PKCS#8 в
памяти и передаёт Wrangler через stdin — не в аргументах, переменных окружения, файлах,
журнале установщика, state или логах. `client_secret` и `webhook_secret` из ответа GitHub
не сохраняются. Worker на каждый тик без действующего токена подписывает JWT (RS256,
WebCrypto) и получает installation token на час — только на repo установки и права
Actions: write, Contents: read; лог Worker не содержит ни ключа, ни токена. Токен
установки, Repository Secrets, сессия ChatGPT и state в Cloudflare не попадают.

У ключа нет срока: защиту сроком заменяет отзыв. Утечка ключа позволяет выпускать
installation tokens приложения — запускать, отменять и отключать workflow и читать repo
(state без credentials); при установке приложения на все repo — во всех repo владельца.
Передать команду она не позволяет: dispatch принимает только пустой input,
`{"command":"status"}` и admin-команду, зашифрованную ключом токена установки (тикет 34).
При подозрении на утечку удалите ключ на странице приложения (Private keys) или само
приложение; новый ключ генерируется там же вручную и записывается через `k Токены` →
«Ключ таймера» (раздел «Токены (`k`)») — GitHub не выпускает ключи через API.
Если отказаться от стороннего сервиса, окна будить нечем: честный вариант — managed cron
GitHub со статусом best effort, в этой версии он не поставляется.

## Токен установки

Предзаполненная форма — `https://github.com/settings/personal-access-tokens/new` с
параметрами `name`, `description`, `expires_in=366` и `contents`, `secrets`, `actions`,
`actions_variables`, `workflows` = `write`, `plan` = `read` (ключи проверены в тикете 39).
Repo форма не задаёт: его выбираете вы. Workflows нужен только `1 Install` и `8 Upgrade`,
которые публикуют файл workflow; повседневные jobs пишут план таймера через Contents.
Plan: read читает план и месячный usage владельца для автономной квоты.

Форма не гарантирует ни срок, ни один repo (тикет 39), поэтому установщик проверяет
выпущенный токен им самим:

- repo private и совпадает с введённым; пробные чтения Secrets public key, Variables,
  Workflows и Contents. Workflows: write чтением не проверяется — его доказывает
  публикация workflow при Install/Upgrade;
- Plan: read: `/user` и billing usage summary владельца. Новой установке и `k → 1` без него
  установщик отказывает (`installation_token_plan_required`); установке, обновлённой
  со старым PAT, показывает предупреждение и подсказку `k → 1`;
- срок из заголовка `GitHub-Authentication-Token-Expiration`. Истёкший токен отклоняется.
  Срок меньше года принимается: установщик показывает дату и подсказывает перевыпуск
  с Expiration 366 days. Токен без срока допускается, напоминания у него нет;
- доступ к другим private repo (`/user/repos?visibility=private`): установщик
  предупреждает и продолжает. Безопаснее перевыпустить токен с **Only select repositories**:
  широкий токен в Repository Secrets даёт запись во все repo владельца.

Срок хранится в state (`installation.grant.expiresAt`): его передают `init` и `k → 1`. За
14 дней до истечения установщик напоминает при запуске и в `s`, jobs — в Actions Summary.
Ротация — `k Токены` → «Токен установки» (раздел «Токены (`k`)»).

**Где хранится локально.** Принятый токен установщик сохраняет в login Keychain как generic
password: service `auto-reset`, account `owner/repo`. Команды `/usr/bin/security -i` получают
токен только через stdin — не через аргументы, переменные окружения или файлы. При запуске
сохранённый токен проходит те же проверки; если GitHub его отклоняет (истёк, отозван),
установщик просит новый и заменяет запись. Если Keychain недоступен (отказ доступа, нет
ответа 2 минуты), токен вводится скрыто и в этот раз не сохраняется. После подтверждённого `k → 1`
запись заменяется новым токеном, после подтверждённого `9 Uninstall` — удаляется.

Удалить вручную: `security delete-generic-password -s auto-reset -a owner/repo` или
«Связка ключей» → поиск `auto-reset` → удалить запись. Посмотреть:
`security find-generic-password -s auto-reset -a owner/repo` (без `-w` значение не выводится).

**Токен установки истёк.** Job с истёкшим или отозванным токеном останавливается до
чтения state; Actions Summary называет причину вместо голого `stop_grant`. `k → 1` уже не
поможет: команду исполняет job с прежним Secret. Восстановление:

1. Выпустите новый токен установки по ссылке (пустой ввод в установщике).
2. GitHub → repo → Settings → Secrets and variables → Actions → `AUTO_RESET_GITHUB_TOKEN`
   → Update: вставьте новый токен.
3. Запустите установщик: токен из Keychain GitHub отклонит, и установщик попросит новый —
   введите тот же новый токен. Если установка не на паузе — `7 Пауза`.
4. `k → 1` с тем же новым токеном: writer перепривяжет к нему сессию и запишет срок.

## Токены (`k`)

`k Токены` показывает все учётные данные установки одной таблицей (на терминале — в рамке,
без TTY — строками через `|`):

```
#  Доступ            Хранится            Истекает     Состояние
1  Токен установки   Keychain + Secret   2027-10-14   ✓
2  Ключ таймера      Cloudflare secret   —            ✓ подтверждён
3  Сессия ChatGPT    Secret (bundle)     авто         ✓
```

Состояние с `!` требует действия: токен установки истекает в ближайшие 14 дней или не
имеет Plan: read; проба таймера не подтверждена или таймер ещё на токене таймера (`c`);
сессии нужен повторный вход (`2`). Пока такая строка есть, меню показывает `k Токены !`.
Номер строки и Enter запускают её действие, пустой ввод возвращает в меню:

1. **Токен установки** — на паузе (`7`), без незавершённой команды: предзаполненная форма →
   проверки раздела «Токен установки» → `rotate-grant` → после подтверждения новый токен в
   Keychain и напоминание отозвать прежний в GitHub. Затем `6`.
2. **Ключ таймера** — горячая замена без паузы, пробы и повторного enable: установщик
   открывает `https://github.com/settings/apps/<slug>` → **Private keys → Generate a private
   key**, спрашивает путь к скачанному `.pem` (файл можно перетащить в окно), переводит
   ключ в PKCS#8 в памяти и проверяет его: JWT нового ключа должен найти ту же установку
   приложения, что записана в state, а узкий installation token — прочитать repo и план.
   Только после этого ключ уходит в `wrangler secret put TIMER_APP_KEY` через stdin; vars,
   код Worker, state и план не меняются, admin-команда не отправляется. Установщик
   показывает отпечаток нового ключа (`SHA256:…`, как на странице App) и напоминает удалить
   там все прежние ключи, затем предлагает удалить скачанный файл (`YES`). Пока прежний
   ключ не удалён, он остаётся действительным. Для таймера на прежнем токене строка
   подсказывает переход `7 → c → 6`, без приложения — шаг `c`.
3. **Сессия ChatGPT** — то же, что `2 Вход/reconnect` (на паузе), затем `3`.

## Настройка автономной квоты

После `1 Install` дождитесь подтверждённого init. Существующей установке сначала
нужно явное `8 Upgrade` до версии с этим меню: старый pinned writer не понимает
новые команды. Установка должна быть на паузе, план таймера — пустым.

1. Токену установки нужны **Variables: write** и **Plan: read** — форма из раздела
   «Токен установки» их задаёт. Токен, выпущенный до тикета 40, замените через
   `k Токены` → «Токен установки» и дождитесь результата; прежний доступ до подтверждения не отзывайте.
   [GitHub Variables API](https://docs.github.com/en/rest/actions/variables#create-a-repository-variable)
   требует Variables: write для сохранения политики бюджета.
2. В GitHub Settings → Billing проверьте account-wide Actions budget **$0** и
   **Stop usage: Yes**. Установщик не меняет этот бюджет и не умеет читать его через
   personal API. После смены бюджета или плана повторите настройку.
3. `q Настроить квоту`: подтвердите бюджет (`YES`) и укажите `free`/`pro`. Токен не
   спрашивается: billing читается токеном установки. Публичная политика сохраняется как
   `AUTO_RESET_BILLING_POLICY`. Writer проверяет владельца, план, текущий billing и
   историю jobs до публикации.
4. Дождитесь подтверждения команды. При неподтверждённой доставке выберите `r Resume`:
   повторяется тот же command ID и зашифрованное содержимое. После прерванной публикации
   установка остаётся disabled, а другие команды ждут Resume.
5. `b Проверить квоту` запускает новую job, которая получает политику из workflow,
   повторно читает provider токеном установки и отмечает проверку в durable state.
   `s Состояние` и Actions Summary показывают результат. Ошибка или ещё не пришедшие
   настройки не дают разрешения включить расписание: исправьте причину и повторите `b`.
6. После выбора сброса и проверки подключения `6 Включить/возобновить` получает
   свежую квоту в runner. Ввод JSON receipt больше не требуется. Gate
   `AUTO_RESET_PILOT_APPROVED` сохраняется; настройка квоты сама по себе не включает расписание и не применяет сброс.

Повторная `q` сбрасывает прежнюю отметку проверки. Setup/check jobs расходуют
Actions минуты и входят в общий admission пилота. Проверка подключения provider
не означает достаточный бюджет расписания: планировщик проверяет его при enable.
Ошибка настроенного provider не допускает fallback к ручному receipt.
При uninstall политика удаляется до Secret токена установки.

**Переход с отдельного billing-токена.** До тикета 40 billing читался отдельным токеном
из Secret `AUTO_RESET_BILLING_TOKEN`. Новая версия его не использует: workflow его не
передаёт, а первая admin-команда новой версии после `8 Upgrade` удаляет этот Secret и
сбрасывает отметку проверки квоты. Порядок: `8 Upgrade` → при предупреждении о Plan: read —
`k → 1` с новым токеном установки → `b` → `6`. Прежний billing-токен отзовите в GitHub.

### English: autonomous quota setup

Install and wait for confirmed init; existing installations must explicitly upgrade
first. Pause the installation and confirm that its timer plan is empty. The installation
token needs **Contents, Workflows, Secrets, Actions and Variables: write** and
**Plan: read**; the prefilled form sets them. Replace an older token through
`k Tokens` → "Installation token", and wait for confirmation before revoking the old grant.

Choose `q Set up quota`. Confirm your account-wide Actions budget of **$0** with
**Stop usage: Yes** and select `free` or `pro`. No token is asked for: billing is read
with the installation token. The installer validates billing access and saves the policy
through the Actions writer; the local journal contains only encrypted input.
If delivery is unconfirmed, use `r Resume` with the same command.

After setup completes, choose `b Check quota`. A new job reads the saved configuration
and verifies the provider. Check `s Status` and Actions Summary; repeat the check if
propagation or access fails. Enable then obtains a fresh receipt in the runner without
asking for JSON. Quota setup keeps the installation paused and does not activate a reset.
The `AUTO_RESET_PILOT_APPROVED` gate and normal connection/selection prerequisites still apply.

The personal API cannot verify your hard-stop budget. Repeat setup after a budget or
plan change. Setup jobs consume Actions minutes. Provider errors block admission;
there is no manual receipt fallback. Uninstall removes the policy; revoke the GitHub
tokens and the separate ChatGPT CI session afterwards. After `8 Upgrade` from a version
with a separate billing token, the first admin command removes the `AUTO_RESET_BILLING_TOKEN`
Secret and resets the quota check: replace the token with `k → 1` if warned about Plan: read,
then run `b`, and revoke the old billing token.

## Доставка и восстановление

Локальная программа не получает writer lease и не пишет state/auth/план таймера напрямую.
Единственное исключение поставки — bootstrap нового пустого repo до появления workflow:
initial program/tree + основной PAT + workflow со статическим резервом + пустой план.
Шаг таймера локально регистрирует приложение таймера, проверяет его доступ чтением GitHub и
передаёт ключ Wrangler; в repo уходят лишь App ID, slug и installation ID через
зашифрованную admin-команду. После этого auth/admin/state
исполняются в `auto-reset-installation-writer` из 17.

Admin input — bounded JSON (60 000 bytes; обычные команды сохраняют предел 4096).
Payload зашифрован AES-256-GCM ключом из PAT с отдельным domain; AAD связывает repo,
command ID, expected version и action. В state — только fingerprint, durable acceptance
и `installation.operation` pending/done/problem; auth bundle в журнал не попадает.
Encrypted input виден GitHub как ciphertext; PAT и CI tokens нельзя публиковать в логах.

`r Resume` повторяет тот же ID/ciphertext. HTTP dispatch и pending run не подтверждают
принятие. Сначала сравнивается exact fingerprint в `state.commands`; состояние effects
проверяется отдельно по operation. Failed validation сохраняет problem; нужны fresh
status/version и новая команда. Незавершённые seed/upgrade/uninstall/grant rotation
требуют exact redelivery; новые обычные/admin-команды и scheduled account work блокируются.
Cancelled/overflow run не создаёт receipt. Нажатие Resume может доставить дубликат;
durable ID не позволяет повторить завершённый переход.

Seed содержит заранее подготовленный protocol 2 bundle, поэтому exact target можно
повторно опубликовать после сбоя Secret PUT/readback без создания второго session ID.
Reconnect сравнивает всю account/workspace/user identity до target/PUT. Другой аккаунт
нужно подключать отдельным repo/state и отдельным journal. Applied/unknown history
остаётся; даже успешные reconnect/read не разрешают повтор unknown consume.
Protocol 1 migration использует exact прежний Secret snapshot и сохраняет journals.

## Пауза, обновление и удаление

`7 Pause`: durable disable → подтверждённая публикация пустого плана таймера;
неподтверждённая проба таймера отменяется. Failed cleanup остаётся `unconfirmed`, с
прежним наблюдавшимся планом; late run запрещён durable guard. Статический резервный
запуск продолжается раз в сутки и на паузе: он только сверяет state (до 30 job в месяц,
учтены в admission).
`6 Resume` заново выполняет quota admission и сохраняет original hour/expiry/deadline.

`8 Upgrade`: сначала пауза; загрузка явного набора локальных исходников создаёт immutable
commit в том же repo без изменения исполняемого ref. Writer очищает план таймера, проверяет
commit/state migration, меняет pin и публикует workflow из шаблона целевого commit
(только статический резервный cron; managed cron старых pin исчезает вместе с файлом). Auth/history не
берутся из старого checkout. После обновления нужны Check и отдельный Enable.
Late job со старым program pin получает `program_version_conflict` до account RPC.
Миграции поддерживаются только существующим `migrateState`; неизвестная schema отказывает.
Переход на один токен установки выполняет первая admin-команда новой версии (state без
`installation.grant`) — см. «Переход с отдельного billing-токена».

`k Токены` → «Токен установки»: пустой ввод открывает предзаполненную форму; новый токен
проходит проверки раздела «Токен установки» (Plan: read обязателен). При disabled установка
сериализованно проверяет новый repo grant, публикует замену единственного Secret, меняет
fingerprint и записывает срок нового токена (неизвестный срок стирает прежний). Dual envelope допускает
exact Resume после смены job Secret. До confirmed результата прежний токен не отзывать: Keychain
до этого хранит прежний, и Resume в следующем запуске идёт с ним. Confirmed результат (и в том
же, и в следующем запуске) переключает установщик на новый токен и записывает его в Keychain;
затем отзовите прежний. Если Keychain недоступен, новый токен вводится при следующем запуске. Это замена grant, а не отдельный
постоянный setup/auth/workflow token.

`9 Uninstall` требует `DELETE` и исполняется в общем writer:

1. Durable disabled+revoked и сохранённое принятие команды.
2. Writer slot гарантирует, что предшествующий активный job закончил запись результата.
   Отправленный RPC мог завершиться; применённый либо unknown итог и history сохраняются.
3. Подтверждённая очистка плана таймера; незавершённая проба отменяется, запись о таймере
   удаляется из state. При отказе Secrets пока сохраняются; exact Resume продолжает cleanup.
4. Удаление auth bundle, политики квоты (если настроена) и Secret токена установки, затем
   отключение workflow: без PAT Secret резервный cron запускал бы платные failing jobs.
   Только затем operation done.
5. Confirmed результат удаляет запись Keychain (`auto-reset`, `owner/repo`); при отказе
   установщик показывает команду ручного удаления.
6. Установщик предлагает удалить Worker таймера (`wrangler delete`, Wrangler спросит
   подтверждение) и печатает ссылку удаления приложения таймера
   (`https://github.com/settings/apps/<slug>/advanced` → Delete GitHub App). Пользователь
   удаляет приложение, отзывает токен установки (и прежние billing-токен и токен таймера,
   если они были) в GitHub и отдельно завершает принадлежавшую установке CI-сессию ChatGPT. Account/logout
   с access token не подтверждает отзыв refresh-сессии.

Если удалён PAT Secret, но runner завершился до durable final receipt, повторный Actions
job уже не имеет PAT: cleanup остаётся неподтверждённым. Сначала прочитайте сохранённый
state/history и убедитесь, что план таймера пуст, затем вручную проверьте отсутствие
всех Secrets установки и отзовите доступ. Установщик не обещает новый авторизованный runner после
удаления его последнего credential. Repo сохраняется для history; его удаление и изменения
административных настроек Actions выполняет пользователь. При недоступном runner сначала
вручную отключите workflow и удалите Worker таймера, затем Secrets, бюджетную переменную и выданные доступы; отправленный RPC
по-прежнему нельзя считать отменённым.

## Проверка

`test/installer.test.mjs` использует Actions capability, OAuth/account/storage/schedule
fixtures 17/23; bootstrap Git tree fixture покрывает только новую поставку/initial state.
`test/installer-timer.test.mjs` проверяет шаг таймера: пробный слот в плане, подтверждение
только пустым dispatch в этом слоте, отказ enable без подтверждения, отмену пробы паузой,
uninstall, manifest flow на loopback с fake GitHub (state, единственный обмен кода,
владелец), конверсию ключа PKCS#1 → PKCS#8, поиск установки и проверку доступа узким
токеном, переход с токена таймера, вызовы Wrangler на fake spawn и ru/en экраны;
`test/timer-worker.test.mjs` — JWT Worker (подпись проверяется публичным ключом), запрос и
кеш installation token. Живой deploy Worker с приложением таймера в этих тестах не
выполняется; Worker на токене таймера проверял пилот 14 октября 2026.
`test/installer-token.test.mjs` проверяет токен установки: ссылку формы, проверку прав,
Plan: read и срока на fake GitHub, срок в state через `init`/`k → 1`, напоминание ru/en в
Summary, workflow без billing Secret и восстановление после истечения; миграцию Upgrade —
`test/installer-quota.test.mjs`. Живого Upgrade pilot на эту версию не было.
`test/installer-keychain.test.mjs` на fake `security` проверяет Keychain: токен только в
stdin, повторный запуск без ввода, отклонённый токен и недоступный Keychain → скрытый ввод,
обновление после подтверждённой ротации (и при Resume в следующем запуске), удаление при uninstall.
`test/installer-tokens.test.mjs` проверяет `k Токены`: таблицу ru/en в TTY и без TTY, `!` за 14 дней
и при проблеме, ротацию токена установки через `Installer` на fake GitHub, горячую замену ключа
таймера (проверка той же установки, только `secret put` на fake spawn, отказы до Cloudflare).
В stock suite есть отдельная disabled account/metadata read проверка без consume/enable.
Тесты не выполняют реальный login, refresh, revoke, repo/secrets writes или consume.

REST поставка основана на официальных контрактах
[Git trees](https://docs.github.com/en/rest/git/trees),
[commits](https://docs.github.com/en/rest/git/commits),
[refs](https://docs.github.com/en/rest/git/refs),
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
и [repository Secrets](https://docs.github.com/en/rest/actions/secrets).
