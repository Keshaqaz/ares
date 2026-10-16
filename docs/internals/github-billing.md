# Чтение личного GitHub billing

`GitHubBilling.read()` читает account-wide месячный usage summary через токен
установки с `Plan: read` ([ADR-0003](../adr/0003-single-token-timer-app.md)). Это реализованный источник billing facts,
Он используется `readGitHubQuota` для формирования свежего допуска SchedulePlanner.
Workflow передаёт `AUTO_RESET_GITHUB_TOKEN` и публичную настройку
`AUTO_RESET_BILLING_POLICY`; отдельного billing Secret с тикета 40 нет. Тикет 39 вживую
подтвердил, что один PAT с правами repo и `Plan: read` проходит этот контракт без изменений; ручной receipt остаётся legacy API для установок без provider; меню enable требует проверенный provider.
Если provider настроен, его ошибка не разрешает fallback к ручному receipt.

## Подтверждённый контракт

Сначала GET `/user` связывает credential с владельцем установки и проверяет
поддерживаемый личный план Free/Pro. Затем GET
`/users/{owner}/settings/billing/usage/summary?year=YYYY&month=MM` читает весь
текущий календарный месяц UTC без repository/SKU/day фильтров.
Owner и период ответа должны совпасть с запросом. API version — `2026-03-10`.
HTTP Date обоих ответов и завершение чтения должны укладываться в 300 секунд;
переход месяца во время чтения отклоняется. HTTP failures, redirects и ошибки
разбора не дают billing facts. Токен, raw account и repository-level usage не
возвращаются и не печатаются.

Результат содержит период, plan, время наблюдения, reported Linux minutes,
reported paid Actions amount и неподдерживаемые Actions SKU. Linux-минуты берутся
из `grossQuantity`, включая бесплатный расход; `netQuantity=0` не означает,
что jobs не расходовали минуты. Storage в gigabyte-hours не добавляется к минутам,
но его платная сумма учитывается. Другие runner SKU явно отмечаются как unknown:
их нельзя автоматически оценить по цене Linux. Duplicate SKU, отрицательные и
невалидные amounts отклоняются; дробные Linux minutes не считаются известным
минутным расходом.

Источники: [usage REST API](https://docs.github.com/en/rest/billing/usage),
[Plan permission и fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## Живое evidence 9 октября 2026

Новый Plan:read доступ вернул HTTP200 для usage и usage/summary. Summary за
октябрь: `actions_linux grossQuantity=32, discountQuantity=32, netQuantity=0,
netAmount=0`; отдельный `actions_storage` измеряется в gigabyte-hours.
Plan Free, unsupported SKU нет. Сумма Linux соответствует сохранённым округлённым
job timings пилота. Модуль прошёл настоящий read-only check; новые Actions jobs,
account RPC или consume этим не инициируются.

GET personal `/users/{owner}/settings/billing/budgets` вернул HTTP404;
legacy `/users/{owner}/settings/billing/actions` — HTTP410.
Это результаты probes, а не поддерживаемые endpoints модуля.
[Документированный Budgets API](https://docs.github.com/en/rest/billing/budgets)
описывает organization budgets; его `user` scope относится к пользователю
организации. Проверенного personal hard-stop read API пока нет.

## Допуск и границы автономной работы

`reportedPaidActionsAmount=0` подтверждает отсутствие начисления в ответе,
но не доказывает `paidUsageBlocked=true`. HTTP freshness также не доказывает,
что все недавно выполненные jobs уже включены в billing report.
Модуль не возвращает `quota`, `providerRemainingMinutes` или `paidUsageBlocked`.
Сам billing reader не создаёт receipt. Согласованная budget policy и полная
история установки соединяются только в `readGitHubQuota`; ошибка источника
приводит к quota pause и попытке снятия cron.

Пользователь явно согласовал 9 октября 2026: подтвердить account-wide Actions
budget `$0` с `Stop usage` при установке и сохранить эту настройку как обязательное
условие эксплуатации. Расход проверяется API перед каждой job; настройка бюджета
не читается автоматически. Пользователь обязан повторить проверку после её изменения.
Это ограничение должно быть видно до enable. В браузере 9 октября повторно
подтверждены account-wide Actions budget $0 и Stop usage Yes; настройки не изменялись.

`readGitHubQuota` читает полную историю run pages без created-at фильтра:
старый run с новым rerun также учитывается по updated_at. Jobs читаются с filter=all
и pagination, независимые запросы ограничены восемью одновременно. Изменение
числа записей между pages, duplicate IDs, неполные pages или более10000 записей
останавливают admission. Неизвестный runner или сторонний pending workflow
отклоняются; установка предполагает отдельный private repo.

Расход текущего периода = reported account-wide Linux minutes + все округлённые
completed installation job minutes этого месяца + outstanding jobs/runs ×10 минут
таймаута. Этот намеренный двойной счёт консервативно покрывает лаг собственных
jobs; max(billing,jobs) не доказывал бы включение собственных jobs и других repo.
Текущая job также резервируется. Будущие периоды до365дней прогнозируются по
зафиксированному плану Free2000/Pro3000 и тому же фиксированному hard-stop budget;
текущая очередь резервируется в каждом периоде. Смена плана требует обновления
настройки; paid amount>0 или неизвестный SKU останавливают provider.

ProviderRemainingMinutes — консервативная оценка по свежему report и собственному
журналу jobs, не гарантированный остаток: unreported jobs других private repo
не видны repository-scoped токену. Финансовая защита зависит от сохранённого
$0 hard stop, а не от предположения об отсутствии внешней очереди. Локальный
лимит1000 и резерв100 сохраняются; planner объединяет цикл/discovery и старые
cron при cleanup. UsedMinutes здесь включает предварительные резервации и
двойной счёт; его нельзя выдавать за фактический provider bill.

Свежесть проверяется после полного сбора; readQuotaReceipt ограничивает scheduler
admittedUntil до observedAt+301. Final guard после асинхронного startup/refresh
не может отправить consume после истечения этих данных.
Данные нельзя освежать перестановкой observedAt у старого ручного receipt.

Проверки на Node26.10.0: reader14 passed, quota provider12 passed; полный offline
набор265 passed/14 expected stock skips, официальный stock synthetic25 passed.
Есть regression истечения receipt во время startup, pagination/reruns,
неизвестного runner, paid usage, отсутствующей current job и fixed budget policy.

9 октября runner37877508205 на pin7553bd3ea313b0f44e922ea34d32b642bc5049fd
самостоятельно прочитал новый Secret и API: quotaProblem null,
reportedLinuxMinutes34, completedMinutes34, outstandingMinutes10,
runCount/jobCount29. Расчёт used78 включает двойной счёт и текущий резерв,
а не фактический bill78. Durablev105 disabledtrue, cron[], authready generation2,
один прежний applied request. Нового consume нет. Это подтверждает доставку
credential и чтение provider в runner; длительная cron выборка этим не доказана.

## Provisioning через установщик

`q` доставляет подтверждённую пользователем политику в зашифрованной admin-команде
`configure-quota`; токен не спрашивается, команда с полем `billingToken` от прежнего
установщика отклоняется. Disabled writer сначала проверяет billing/provider токеном
установки и пустой план таймера (до тикета 37 — managed cron), затем сохраняет durable
pending publication и публикует/сверяет repository variable. Токену установки нужны
**Variables: write** и **Plan: read**. После сбоя публикации exact Resume восстанавливает
ту же конфигурацию; автоматического включения нет.

`b` отправляет `check-quota` в следующую job. Workflow должен получить именно
сохранённую политику; доступ к billing проверяется реальным чтением provider.

Миграция с отдельного billing-токена: state, записанный до тикета 40, не имеет
`installation.grant`. Первая admin-команда новой версии удаляет Secret
`AUTO_RESET_BILLING_TOKEN` (204/404), записывает `grant: null` и снимает отметку
проверки квоты, сохраняя политику: перед enable нужен `b`.
State хранит только политику, verified и checkedAt, без credential или raw billing.
При ошибке provider проверка снимается; повторная конфигурация всегда требует новой
проверки. Enable перепроверяет provider и admission по свежим данным. Сама проверка
provider не гарантирует наличие квоты для будущего расписания.

Offline coverage: `test/installer-quota.test.mjs` проверяет encrypted delivery,
owner/plan/access failures, Variables permission, lost variable response,
exact Resume, stale/несовпадающую конфигурацию, ru/en экран без токена, uninstall и
миграцию Upgrade (однократное удаление Secret, повторный `b`).
Реальная поставка этого нового экрана в GitHub в рамках подготовки 22 не выполнялась.
