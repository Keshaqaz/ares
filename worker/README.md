# Внешний таймер (Cloudflare Worker)

Реализация [ADR-0002](../docs/adr/0002-external-timer.md), тикет 36; доступ к GitHub —
через приложение таймера ([ADR-0003](../docs/adr/0003-single-token-timer-app.md), тикет 42). Worker только
будит приватную установку: он не хранит сессию ChatGPT, не решает о применении
сброса и не передаёт команд. Повтор, `nextAttemptAt`, граница цикла и запрет
раннего consume остаются в state и workflow, поэтому поздний или двойной тик
даёт обычный reconcile.

## Поведение

- Cron Trigger `2-57/5 * * * *` — та же сетка `:02`/5 минут, что у планировщика
  (`src/schedule-time.mjs`).
- Каждый тик сначала получает installation token приложения таймера (см. ниже), затем
  читает опубликованный план окон (`readPlan` в [index.mjs](index.mjs)) —
  файл `.auto-reset-timer-plan.json` на `main` (тикет 37): одна каноническая
  JSON-строка `{"schema":1,"expressions":[…]}` с UTC cron планировщика, включая
  discovery. Файл вне `.github/workflows/`, поэтому его правка не перерегистрирует
  нативный cron. Разбор — общий `src/managed-schedule.mjs`
  (`readTimerPlan`/`expandCron`), тот же, что у планировщика и writer; любая
  другая сериализация — `plan_invalid`.
- Статический резервный cron workflow (`41 5 * * *`) в план не входит: его
  запускает сам GitHub, Worker в эту минуту не тикает (вне сетки `:02`/5).
- Минута берётся из `controller.scheduledTime`, а не из текущих часов: в E1
  Cloudflare запускал Worker на 32–34 с позже номинальной минуты.
- При совпадении Worker проверяет, что repo приватный, совпадает с `REPOSITORY`
  и его default branch — `main`; ищет run `auto-reset.yml`, уже созданный в этом
  пятиминутном слоте; если такого нет, отправляет один `workflow_dispatch` на
  `main` с телом `{"ref":"main"}` — без inputs.
- Subrequests: тик без совпадения — 1 (2, если нужен новый installation token), с
  совпадением — не больше 5 (лимит Free — 50). Повторов нет: следующий тик через 5 минут.
- Fail-closed: любая ошибка конфигурации, GitHub (401/403/404/5xx, redirect,
  сеть) или непонятный план — ничего не отправлять. Отсутствующий файл плана —
  `github_not_found`: установщик создаёт пустой план при bootstrap, а первый
  запуск после Upgrade со старого pin — при reconcile.

Одна строка лога на тик, без ключа, токенов, тел ответов GitHub и содержимого плана:

```json
{"autoResetTimer":{"slot":"2026-10-14T10:22:00Z","outcome":"dispatched","problem":null,"status":200,"runId":4242,"token":"cached","subrequests":4}}
```

`outcome`: `idle`, `dispatched`, `duplicate`, `failed`. `token`: `issued` (новый
installation token), `cached`, `null` (до запроса). `problem`: `key_missing`, `key_invalid`,
`app_invalid`, `repository_invalid`, `clock_invalid`, `app_unauthorized` (ключ отозван или
App удалён), `app_forbidden`, `installation_not_found` (App удалён с repo),
`app_permissions_denied` (у установки нет repo или права), `plan_invalid`, `repository_mismatch`,
`branch_mismatch`, `github_unauthorized`, `github_forbidden`, `github_not_found`,
`github_unavailable`, `github_unexpected`, `github_unreachable`, `internal_error`;
у `dispatched` возможен `run_id_missing` (dispatch принят, ID не вернулся —
повтора нет).

## Приложение таймера

GitHub App пользователя, а не токен: установщик регистрирует его по manifest
(шаг `c`), пользователь нажимает Create и Install.

- Права App: **Actions: Read and write**, **Contents: Read-only** (Metadata: Read-only
  GitHub добавляет сам); webhook выключен (URL-заглушка `https://example.invalid/…`
  с `active: false` — без URL GitHub manifest не принимает). Больше ничего.
- Установка — **Only select repositories**, repo установки. Ссылка установки repo не
  предвыбирает; установку на все repo установщик показывает предупреждением и
  продолжает (ADR-0003, пересмотр 16 октября).
- Vars `TIMER_APP_ID` и `TIMER_INSTALLATION_ID` — ID приложения и установки, не секреты.
- Secret `TIMER_APP_KEY` — **ключ таймера**: закрытый ключ App в PKCS#8 одной строкой
  base64 (DER) или PEM. GitHub выдаёт PKCS#1 (`BEGIN RSA PRIVATE KEY`) — такой ключ
  Worker отклоняет (`key_invalid`), его сначала переводят в PKCS#8. Ключ есть только
  в этом secret: в `wrangler.toml`, файлах, state и логах его нет. Срока у ключа нет.
- Каждый тик без действующего токена подписывает JWT (RS256, WebCrypto; `iat` минус
  60 с, `exp` плюс 540 с) и запрашивает
  `POST /app/installations/{id}/access_tokens` с `repositories: [<repo>]` и
  `permissions: { actions: write, contents: read }`: даже установка на все repo даёт
  токен только на repo установки. Токен живёт час; изолят держит его до 5 минут до
  истечения, а отклонённый GitHub (401/403) выбрасывает сразу.

Что даёт утечка ключа: выпуск installation tokens — запуск и отключение workflow,
чтение repo (state без credentials), при установке на все repo — во всех repo
владельца. Открытые команды через dispatch отклоняются (тикет 34). Отзыв — удалить
ключ на странице App (Private keys) или удалить App.

Если Worker перестал будить установку, это замечает только суточный резервный
запуск: он сравнивает последний пустой dispatch с плановыми слотами и при
отставании больше 30 минут завершается с `external_timer_stale` в Summary
([docs/private-workflow.md](../docs/private-workflow.md#внешний-таймер-и-резервный-запуск)).

## Развёртывание

Production выполняет установщик (шаг `c`): регистрирует App, находит установку,
проверяет доступ узким токеном и вызывает Wrangler, закреплённый на версии из E1:

```sh
npx --yes wrangler@4.139.0 deploy --config worker/wrangler.toml --var REPOSITORY:<owner>/<repo> --var TIMER_APP_ID:<app id> --var TIMER_INSTALLATION_ID:<installation id>
npx --yes wrangler@4.139.0 secret put TIMER_APP_KEY --config worker/wrangler.toml
```

- Ключ уходит в `secret put` только через stdin — не в аргументы, env или файлы.
  Пока секрета нет, тики пишут `key_missing` и ничего не отправляют.
- `REPOSITORY`, `TIMER_APP_ID`, `TIMER_INSTALLATION_ID` в [wrangler.toml](wrangler.toml)
  пустые; каждый deploy передаёт их через `--var`, иначе Worker fail-closed
  (`repository_invalid`, `app_invalid`).
- `workers_dev = false`: у Worker нет fetch handler и публичного URL.
- Изменение Cron Trigger распространяется до 15 минут.
- Лог: `npx --yes wrangler@4.139.0 tail --config worker/wrangler.toml`.
- Замена ключа (утечка, потеря): установщик, `k Токены` → «Ключ таймера» — открывает
  страницу App (Private keys → Generate a private key), проверяет скачанный ключ на той же
  установке и передаёт его в `secret put TIMER_APP_KEY` через stdin без паузы, пробы и
  повторного enable ([installation.md](../docs/installation.md#токены-k)). Вручную — то же
  через GitHub → Settings → Developer settings → GitHub Apps → приложение → Private keys →
  Generate a private key; затем из корня репозитория

  ```sh
  openssl pkcs8 -topk8 -nocrypt -outform DER -in <скачанный>.pem | base64 | tr -d '\n' | npx --yes wrangler@4.139.0 secret put TIMER_APP_KEY --config worker/wrangler.toml
  ```

  удалить скачанный `.pem` и прежний ключ на странице App. Проба не нужна: App и
  установка те же.
- Переход с токена таймера (установки до тикета 42): Пауза → `c`. Установщик
  записывает `TIMER_APP_KEY`, удаляет secret `TIMER_TOKEN` (Wrangler спросит
  подтверждение) и ставит пробу; после подтверждения отзовите прежний токен таймера.
  Вручную: `npx --yes wrangler@4.139.0 secret delete TIMER_TOKEN --config worker/wrangler.toml`.
- Удаление: `npx --yes wrangler@4.139.0 delete --config worker/wrangler.toml`, затем
  удалить приложение таймера: Settings → Developer settings → GitHub Apps →
  приложение → Advanced → Delete GitHub App (установщик печатает прямую ссылку).

## Тесты

`test/timer-worker.test.mjs` входит в общий `npm test`: настоящий `tick()` против
fake GitHub (`testing/timer-fixture.mjs`) с production-шаблоном workflow, без сети
и без Cloudflare. Fake GitHub проверяет подпись JWT публичным ключом синтетического
App, claims и тело запроса installation token; кеш токена — отдельный тест.
