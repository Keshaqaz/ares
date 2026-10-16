# Поддержка и границы проверки / Support and verification

Пакет 0.1.0 — локальный выпуск исходного кода после завершения личного пилота
(14 октября 2026). Живые результаты подтверждают конкретные версии и одну личную
установку, а не любые аккаунты, планы или регионы. Автоприменение выключено по
умолчанию; живой consume требует отдельного решения владельца (gate
`AUTO_RESET_PILOT_APPROVED`, см. [workflow](internals/private-workflow.md#поставка-и-допуск)).
Private evidence и credentials в исходный пакет не входят.

Финальный source пакета совпадает с последним развёрнутым в пилоте program pin
`d1bad488165a59a1e2465d078f0bdc6cc386f0bd` по 44 из 45 программных файлов установки;
отличается только `src/installer/installer-timer.mjs` — исправление проверки токена таймера
(до первой публикации плана), которое выполняется на Mac и в CI не поставляется.
После пилота `src/` разложен по папкам (account, session, core, schedule, github, workflow,
installer): изменились только пути и импорты, логика та же. Новая раскладка проверена
offline-тестами и сборкой пакета; живой Upgrade установки на неё не выполнялся.

| Область / Area | Уровень / Level | Подтверждение / Evidence | Граница / Boundary |
| --- | --- | --- | --- |
| Недельный guard, state, ru/en опция | Offline client; stock synthetic | [Account](../src/account/account.mjs), [engine](../src/core/reset-cycles.mjs), [contract cases](../test/contract.test.mjs), [host startup cases](../test/private-workflow.test.mjs) | Identity-bound окно 10080; fresh до min(resetsAt, read+300с); пять часов отдельно. Живой consume при недельном исчерпании не выполнялся: synthetic не live consume |
| Общие правила, монитор `m`, apply-now без недельного guard (14 октября) | Offline client | [engine](../src/core/reset-cycles.mjs), [monitor](../src/installer/monitor-ui.mjs), [rule cases](../test/reset-cycles.test.mjs), [sealed control](../test/private-workflow.test.mjs), [monitor tests](../test/monitor-ui.test.mjs) | Stock App Server contract и live не запускались; production на прежнем коде до Upgrade |
| Auth/publication/current-job proof | Offline/stock synthetic; live | [Host](../src/session/host-auth-session.mjs), [ADR](adr/0001-host-owned-auth.md), [stock suite](../test/private-workflow-runtime-contract.test.mjs) | Host-owned refresh, publication generation 1→2→3 и замена PAT grant (`rotate-grant`) прошли вживую. External API experimental. Scope/TTL/grace серверной idempotency неизвестны |
| Hosted Linux runner/prerequisites | Hosted live | [Workflow](internals/private-workflow.md), [pins](../src/runtime-lock.json) | Node 26.10.0, stock 0.160.1, protocol 2. Последние jobs пилота 14 октября 2026 на pin `d1bad488…` |
| Реальное применение одного выбранного ID | Historical live | [Механизм](internals/reset-activation-verified.md) | Source dabce8c87dbece8149ce45776b3e4720d4495178, 9 октября 2026. Один applied; второй/replay не проверяется |
| Автономный billing provider | Historical hosted/live | [Billing](internals/github-billing.md), [provider](../src/github/github-quota.mjs) | Source 7553bd3ea313b0f44e922ea34d32b642bc5049fd, 9 октября 2026. Receipt должен обновляться перед job; personal budget подтверждает владелец |
| configure-quota → check-quota в разных jobs | Offline + hosted passed | [Setup](../src/installer/installer-quota.mjs), [tests](../test/installer-quota.test.mjs) | Source 2ff62eed3d9e276001d3ebf92900f62c2018290e, 10 октября 2026: разные jobs, accepted durable receipts, policy/Variable совпали, проверка отмечена. Disabled, runtime pins сохранены |
| Dispatch принимает только пустой input, status и sealed admin; открытый control отклоняется | Offline client; live (пустой dispatch) | [Граница](../src/installer/installer-admin.mjs), [workflow](internals/private-workflow.md#сериализация-и-команды), [tests](../test/private-workflow.test.mjs) | Тикет 34. Приложение таймера (и прежний токен таймера) может запускать, отменять и отключать workflow и читать repo, но не передавать команду |
| Доставка окон внешним таймером Cloudflare (пустой dispatch по плану), резервный cron раз в сутки | Live passed | [ADR-0002](adr/0002-external-timer.md), [Worker](../src/worker/README.md), [установка](installation.md#внешний-таймер), [tests](../test/installer-timer.test.mjs) | Эксперимент E1, 11 октября 2026 (Bangkok): 24/24 dispatch, runs стартовали за 36–39 с. Пилот 14 октября: Worker установки (Wrangler 4.139.0) в пробный слот установщика отправил пустой dispatch, run создан через 35 с, проба подтверждена, план очищен. Окно проверено на disabled установке, без account read/consume. Нативный `schedule` не критерий (39 слотов/0 runs). Без SLA Cloudflare/GitHub и exactly-once |
| Revoke accepted + прекращение access и refresh | Live passed | [Verifier](../src/session/revoke-verifier.mjs), [tests](../test/revoke-verifier.test.mjs), [script](../scripts/revoke-session.mjs) | 14 октября 2026: revoke HTTP 200; тот же access token получил 401 не позже 44 с после последнего успешного чтения, до своего expiry; единственная попытка старого refresh — 401 `refresh_token_invalidated`. Глобальная propagation и family scope не заявляются: сервер причину не называет |
| Чтение при естественно исчерпанной пятичасовой квоте | Известное ограничение: live не проверено | [Observer](../src/account/check-observer.mjs), [tests](../test/check-observer.test.mjs) | Покрыто synthetic проверками и реальной структурой ответа (окна 300 и 10080, 9 октября 2026). Живой ответ при нуле не наблюдался |
| Платные планы ChatGPT | Известное ограничение | [Observer](../src/account/check-observer.mjs), [state](internals/reset-cycle-state.md) | Продукт рассчитан на платные планы с окнами 300 и 10080 мин. После окончания подписки аккаунт пилота отдавал одно окно 43200 мин: недельное автоприменение на такой структуре не срабатывает и сброс не расходует |
| Один токен установки: форма PAT, проверка прав/Plan: read/срока, billing тем же токеном, напоминание за 14 дней, миграция Upgrade (тикет 40, 16 октября) | Offline client | [Token](../src/installer/installer-token.mjs), [migration](../src/installer/installer-quota.mjs), [установка](installation.md#токен-установки), [tests](../test/installer-token.test.mjs), [quota tests](../test/installer-quota.test.mjs) | Факты формы и billing одним PAT — живая проверка тикета 39 (private evidence в пакет не входит): `expires_in=366` дал 30 дней, repo форма не ограничила. Живого Upgrade pilot на эту версию не было; production на прежнем коде до Upgrade |
| Токен установки в macOS Keychain: ввод один раз, отклонённый/недоступный → скрытый ввод, обновление после `k → 1`, удаление при uninstall (тикет 41, 16 октября) | Offline client; локальный Keychain | [Keychain](../src/installer/installer-keychain.mjs), [установка](installation.md#токен-установки), [tests](../test/installer-keychain.test.mjs) | `security -i` получает токен только через stdin. Модуль проверен на реальном login Keychain с одноразовой записью (запись, чтение, замена, удаление). Полный запуск установщика с Keychain вживую не проводился |
| Меню `k Токены`: таблица токена установки, ключа таймера и сессии ChatGPT с `!` за 14 дней/при проблеме; ротация токена, горячая замена ключа таймера без паузы и пробы (тикет 43, 17 октября) | Offline client | [Tokens](../src/installer/installer-tokens.mjs), [установка](installation.md#токены-k), [tests](../test/installer-tokens.test.mjs) | Экран ru/en (TTY и без TTY), ротация через настоящий `Installer` на fake GitHub, замена ключа на fake GitHub и fake spawn Wrangler. Живая замена ключа App (Generate → `secret put` на Worker pilot) не проводилась |
| Мастер первичной настройки `i`: Install → вход ChatGPT (2/3/4) → квота (q/b) → таймер (c, проба) подряд, продолжение с первого невыполненного шага по state; enable и gate — отдельно (тикет 44, 17 октября) | Offline client | [Wizard](../src/installer/installer-wizard.mjs), [установка](installation.md#запуск), [tests](../test/installer-wizard.test.mjs) | Шаг по state, прогон ru/en (TTY и без TTY) на fake-шагах, `0`/отказ/сбой/нет прогресса → меню, исходник CLI. Живой первый запуск на новом repo не проводился |
| Allowlist source package, hashes, notices | Local artifact | [Builder](../scripts/release-package.mjs), [package tests](../test/release-package.test.mjs), [MIT](../LICENSE), [notices](NOTICES.md) | Canonical metadata и hashes фиксируют состав; повторная сборка совпадает побайтно |

Прогноз расхода занижен: планировщик закладывает 2 Linux-минуты на job, а все четыре
job пилота 14 октября 2026 (disabled, без account read) длились 133–152 с — 3 округлённые
минуты. Provider читает фактический расход перед каждой job, а платный расход
останавливает бюджет владельца `$0 + Stop usage`, но прогноз планировщика, фактический
запас 100 минут и оценка 522–616 минут в месяц из ADR-0002 занижены.

**Токен установки истёк / Installation token expired.** Jobs останавливаются до чтения
state; Actions Summary называет причину (`stop_grant`). `k → 1` не поможет: команду исполняет
job с прежним Secret. Выпустите новый токен установки, вставьте его в Repository Secret
`AUTO_RESET_GITHUB_TOKEN` (Settings → Secrets and variables → Actions → Update), запустите
установщик с ним, при необходимости `7 Пауза`, затем `k → 1` с тем же новым токеном
([подробно](installation.md#токен-установки)). Путь проверен offline, не вживую.
Jobs stop before reading state and the Summary names the cause; issue a new token, write it
to the `AUTO_RESET_GITHUB_TOKEN` Secret by hand, start the installer with it, pause if
needed, then run `k → 1` with the same token. Verified offline only.

Также не подтверждено: живой consume по окну таймера на включённой установке,
приложение таймера вживую (тикет 42: manifest flow, ключ в Worker secret, JWT и
installation token в Cloudflare проверены offline и фактами тикета 39, deploy Worker с
приложением и переход pilot с токена таймера — отдельным шагом с пользователем; CPU-лимит
Free на подпись RS256 на edge не измерен), личные бюджеты GitHub кроме подтверждённого
владельцем `$0 + Stop usage`.

**English:** Source package 0.1.0 after the personal pilot closed on 14 October 2026. After the pilot, `src/` was split into folders; only paths and imports changed, verified offline, without a live Upgrade.
The table distinguishes local client tests, stock App Server tests against a
synthetic backend, and live/hosted evidence from one personal installation. The
final source matches 44 of the 45 installer program files deployed at pilot pin
`d1bad488165a59a1e2465d078f0bdc6cc386f0bd`; only `src/installer/installer-timer.mjs` differs
(a Mac-side fix to timer token verification before the first plan exists).

Passed live: host-owned refresh and publication, one selected reset applied
(9 October), hosted configure/check-quota in separate jobs (10 October), window
delivery by the installed Cloudflare Worker — an empty dispatch in the installer's
probe slot started a run 35 seconds later — and revoke: HTTP 200, the same access
token rejected within 44 seconds and before expiry, a single old-refresh attempt
rejected with `refresh_token_invalidated`. The delivery window ran on a disabled
installation without account reads or consumption. Global revoke propagation and
family scope are not claimed. Since ticket 34 the workflow_dispatch input accepts
only an empty value, exact status or a sealed admin command.

Since ticket 40 the installer issues one installation token from a prefilled form and
checks it (permissions, Plan: read, actual expiry, other private repos); billing is read
with it, and Upgrade removes the old `AUTO_RESET_BILLING_TOKEN` Secret. This is offline
evidence only; no live Upgrade pilot has run on this version.

Since ticket 42 the Worker reaches GitHub through the timer app (a GitHub App created with
Create and Install, key in the `TIMER_APP_KEY` Worker secret, one-hour installation token
narrowed to the repo) instead of a timer token. The manifest flow, key conversion, JWT and
token request are covered offline and by the ticket 39 facts; the Worker deploy with the
app, the pilot's move from the timer token and the RS256 CPU cost on Workers Free at the
edge are not verified live.

Known limitations: reading at a naturally exhausted five-hour quota was not observed
live (covered by synthetic tests and the real 300/10080 response shape from
9 October 2026). The product targets paid ChatGPT plans; after the pilot
subscription ended the account reported a single 43200-minute window, and with any
such layout the weekly automation does not fire and spends no reset. Live weekly
consumption and a window-triggered consume on an enabled installation were not run.
The planner budgets 2 Linux minutes per job, while every pilot job on 14 October took
133–152 seconds (3 rounded minutes); the provider reads actual usage before each job and the
owner's `$0 + Stop usage` budget blocks paid usage, but the planner forecast, the
effective 100-minute reserve and ADR-0002's monthly estimate are understated.
Automatic consumption stays off by default and requires the owner to set
`AUTO_RESET_PILOT_APPROVED`. A successful synthetic test does not confirm live
consumption at zero, universal plan/region support, an exactly-once guarantee, a
scheduling SLA, or a personal billing ceiling.

The current source is pinned by `dist/release-manifest.json` next to the archive.
After changing input, build and verify again. The package contains no private
tracker/evidence.
