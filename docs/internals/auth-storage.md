# CI-сессия: внешний вход, обновление и публикация

8 октября 2026 года. [ADR-0001](../adr/0001-host-owned-auth.md) реализован в
[host-owned runtime](../../src/session/host-auth-session.mjs) поверх storage из 15.
Программа владеет отдельной CI-сессией и OAuth refresh. Stock App Server получает
только access token. Общий CLI/workflow и установщик реализованы в 17/18; реальная установка
проверена в пилоте 21 ([границы](../support.md)); synthetic проверки её не заменяют.

## Закреплённый контракт

Node **26.10.0**, официальный App Server **0.160.1**, commit
`d27764b82f7118f674371e6d6e76271d9d606edb`; Linux URL/checksum — `runtime-lock.json`.
Версия binary проверяется перед запуском, initialize проверяет userAgent. Собственной
сборки и managed refresh в runner нет. LibSodium versions/integrity закреплены lockfile.

`HostOAuth` использует default client ID `app_EMoamEEZ73f0CkXaXp7hrann`, endpoint
`https://auth.openai.com/oauth/token`, JSON POST с `client_id`,
`grant_type=refresh_token`, `refresh_token`. Redirect, повтор и proxy fallback
отключены; timeout — 15 секунд. Environment overrides desktop не наследуются.
Synthetic endpoint допускается только как явно переданный loopback URL.

[Refresh source](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/login/src/auth/manager.rs):
отсутствующие/null optional access/id/refresh fields сохраняют прежние значения;
присутствующий непустой string заменяет поле. Клиент отклоняет пустые, malformed и
полностью пустые ответы. Полный bundle проверяется до публикации; `last_refresh`
обновляется host. Это проверенная клиентская семантика, а не обещание server rotation.

## Первоначальный вход и интерфейс для 18

`prepareCiLogin({binary})` из `src/session/host-oauth.mjs` возвращает план штатного
`codex -c cli_auth_credentials_store="file" login` с новым временным HOME и
CODEX_HOME (0700), отдельным env и проверенным binary. Установщик показывает и
выполняет интерактивный вход на доверенной машине. UI, browser authorization и
реальный login не исполнялись в 23. Credentials из desktop home не импортируются.

После завершения **всех owned login процессов** установщик вызывает
`plan.complete({processExited:true})`: читает только auth.json из созданного CI home,
проверяет обычный файл 0600, bounded size, managed ChatGPT payload и identity.
Полученный official login API key, если присутствует, отбрасывается: CI bundle
содержит только ChatGPT tokens. Затем `bundleBytes(bundle)` передаются в
`HostAuthAdmin.seed(bytes, grant, expectedVersion)`. Завершение процесса — обязательство
executor 18; boolean seam не является собственным process supervisor.
`plan.cleanup({processExited:true})` удаляет owned home только после exit.

[Login source](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/login/src/server.rs)
задаёт тот же default client/issuer и offline scope. Воспроизводимость initial bundle
проверена синтетическим файлом официального формата; совместимость настоящего login
и refresh grant подтверждена в пилоте 21; серверные ограничения (grace, family) не установлены.

Все admin writers используют `serialization.assertOwner()` общего stream 17/18.
Seed требует актуальной version и durable disable; создаёт новый sessionId,
generation 1, target/readback → зашифрованный Secret PUT → finalize/readback.
После seed установка остаётся disabled. Поля cycles/groups/requests/commands,
исходные границы и flags revoked/reconnectRequested сохраняются.

Reconnect сравнивает новый account/workspace/user с committed **до target/PUT**.
Другой workspace или user отклоняются, прежние Secret и история остаются.
Новый sessionId сам по себе не является доказательством identity. Отдельная установка
с отдельным state требуется для другого аккаунта. Новый подтверждённый login той же
identity может заменить потерянный rotation target при disable; старые tokens не
используются. Pending первый seed без committed требует точного target recovery.

`setupRead(expectedVersion)` — отдельный disabled путь **только** account/read(false).
`setupMetadata(expectedVersion)` из 18 добавляет disabled account/rateLimits/read
для выбора; обе операции запрещают consume/enable и сохраняют unknown journal.
Он проверяет writer, protocol, точный bundle, grant, version и revoked/reconnect;
обслуживает OAuth при необходимости по тому же publication протоколу. Consume/enable
через setup запрещены. Успех не снимает disabled, unknown outcome и не начинает час.
Обычный request/service по-прежнему запрещён при disabled и prior unknown consume.
После настоящего reconnect установщик отдельно подтверждает снятие revoked/reconnect
flags и enable в своём сериализованном потоке; seed/read сами этого не делают.

`HostAuthAdmin.disable(version,{revoke:true})` сохраняет запрет исполнения.
`revokeSession(snapshot,grant,version,oauth)` допускается только для точного ready
protocol 2 bundle при durable disabled+revoked. `HostOAuth.revoke` делает один JSON POST
`token`, `token_type_hint=refresh_token`, `client_id` к `/oauth/revoke`, как
[закреплённый revoke source](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/login/src/auth/revoke.rs).
Результат — `revokeAccepted, propagation:unverified`; lost response/rejection фиксированы,
автоматического повтора нет. При unknown rotation старый bundle не отправляется на
revoke: завершение сессии пользователем — отдельный шаг 18/21. Delete Secret не
отзывает ChatGPT-сессию или PAT. Пилот 21 подтвердил revoke: тот же access и старый refresh
затем отклонены (401); глобальная propagation и family semantics не установлены.

## Bundle, protocol и миграция

Envelope schema **2**, auth protocol **2**. Payload остаётся auth.json форматом у host:
`auth_mode=chatgpt`, access/id/refresh tokens, account_id, last_refresh, без API key.
В runner Codex home этот файл **никогда не восстанавливается**.

Случайные sessionId/bundleId, generation, SHA-256 точных payload bytes и identityDigest
проверяются при encode/decode; размер envelope до 48 KiB. В protocol 2 identityDigest
включает `chatgpt_account_id` (выбранный workspace) и `chatgpt_user_id`. ID/access claims
должны согласовываться. JWT decoding проверяет структуру/согласованность, а не подпись
или entitlement. Неизвестный срок access token вызывает refresh; если срок нового
access всё ещё неизвестен либо до expiry не больше пяти минут, выдача child запрещена.
`expires_in` не подменяет JWT exp, fallback «вечный token» отсутствует.

Storage читает legacy protocol 1 для явной миграции. `HostAuthSession` отклоняет его
до OAuth/child; `AuthSession`/legacy admin отклоняют protocol 2. Старый deployed код 15
не понимает новый protocol/envelope. Rollback не получает права на новый state.
Миграция — `HostAuthAdmin.seed(...,{previousSnapshot:exactLegacyBundleString})` при
disable. Точное совпадение старого tuple доказывается по committed, полная identity
выводится из старого payload и сравнивается с новым login. Coarse legacy digest без
точного bundle недостаточен. Session и protocol обновляются, история/grant boundary
сохраняются. Interrupted migration восстанавливается точным seed target либо новым
входом той же identity с точным legacy bundle.

State auth содержит только IDs/digests, generation/protocol/phase, operation/owner,
PAT fingerprint и фиксированные enums. Account responses/email/tokens туда не копируются.
Receipt legacy не заменяет consume journal и не доказывает selected-ID outcome.
Новые host auth writes обслуживают auth; итог consume записывает владелец journal 17.

## Host lifecycle и recovery

`HostAuthSession` принимает authoritative store, GitHub secrets, serialization, OAuth,
LocalAuthVault, runtime, repository Secret snapshot, PAT и owner. Writer admission
читает актуальный state; проверяет protocol, flags, session/generation/bundle/digests,
fingerprint и отсутствие prior unknown request. Stale queued snapshot останавливается
до OAuth и child. Preflight проверяет private repo/public key, но не доказывает будущие
write permission или отсутствие отзыва PAT между операциями.

При expiry ≤ now+300 или `service({force:true})` порядок:

1. Durable `inflight` intent с operationId/owner → полный state readback.
2. Единственный host OAuth POST, без account/model RPC.
3. Проверка полного bundle/identity → atomic local save и readback.
4. `publishing` с точным target → state readback.
5. LibSodium sealed box → Repository Secret PUT 201/204.
6. Commit target/ready → state readback.
7. Лишь затем проекция access token/account ID/plan выдаётся external runtime.

`LocalAuthVault` — owned plaintext credential file 0600 в private directory 0700,
atomic rename + file/directory fsync + exact readback. Он хранит полный next bundle,
operationId, owner, intentVersion, previous tuple и PAT fingerprint. Это временное
защищённое хранение credentials, не debug/cache/Actions artifact. 17 удаляет его после
завершения owned процессов и запрещает upload; на потерянном ephemeral runner файл
может быть недоступен. Ошибки, RPC audit, state и публичные результаты токены не содержат.

Любая ошибка, timeout/lost response, неподтверждённая запись или process failure
останавливает весь job: нет следующего refresh/account RPC, fallback или повторного consume.
Inflight с потерянным полным target требует нового входа; старый refresh не переиспользуется.

`recoverLocal()` разрешает **только persistence** уже сохранённого точного target:
operation/owner/previous/fingerprint и intentVersion (либо ровно intentVersion+1 для
publishing) должны совпасть. Чужой state write/history change блокирует recovery.
Повторный PUT использует те же bytes, bundleId/generation; OAuth не вызывается.
`recoverLocal({setup:true})` допускает сохранение при disabled с теми же flags/grant
проверками, не разрешает consume и не стирает unknown journal.

Свежий repository Secret snapshot, совпавший с rotation target, доказывает possession
после прерванного PUT/finalize: `admit()` завершает transition без refresh.
Для seed — `HostAuthAdmin.adopt(exactTargetSnapshot,grant,version)`. Caller 17/18 обязан
передавать свежий Secret snapshot или подтверждённый результат собственного PUT;
metadata GET, старый snapshot, таймер или локальный файл сами по себе не доказывают PUT.
Если есть только local target, используется recoverLocal с повторным PUT, а не adopt.
Recovery не меняет request/group journals, ID/ключи и исходные границы.

## External App Server и интерфейс для 17

`ExternalAuthRuntime` запускает чистые HOME/CODEX_HOME/TMPDIR и stock binary. Env
составляется по allowlist; PAT, refresh/id tokens и desktop auth отсутствуют.
Локальный закреплённый каталог предотвращает metadata fetch; model/plugin/apps/telemetry
пути отключены. Stdio allowlist содержит initialize/login и три account RPC, без turn/thread.

После initialize выполняется явный `account/login/start` с type=chatgptAuthTokens,
accessToken, chatgptAccountId и optional chatgptPlanType; ответ должен подтвердить тот
же mode. Один handle выполняет одну account RPC. Params проверяются по allowlist.
Close ждёт exit owned процесса, затем удаляет home; startup/login failures также
завершают процесс до cleanup. При ошибке нет переключения на managed auth.

Pinned account/read может сообщать type=chatgpt или не иметь type. Владелец refresh
задаётся explicit mode и подтверждённым login. `AccountAdapter.refresh()` с host session
возвращает externalOwnerRequired; account/read(true) не считается OAuth обслуживанием.
Unexpected `account/chatgptAuthTokens/refresh` получает фиксированный JSON-RPC отказ
без token, transport завершается, job останавливается. OAuth обслуживается отдельно
до следующего интервала; внутри consume нет host refresh или автоматического replay.

Для consume владелец journal 17 вызывает:

```js
const proof = await session.reserveConsume(async () => {
  // Сохранить НОВЫЙ request journal в authoritative writer stream.
  return { request, version: reservedState.version };
});
const result = await session.request('account/rateLimitResetCredit/consume', {
  creditId: request.creditId, idempotencyKey: request.idempotencyKey,
}, {
  requestId: request.requestId, expectedVersion: proof.expectedVersion,
  reservationProof: proof,
  dispatch: async (send, context) => {
    // После OAuth/publication/startup проверить original deadline, disable/revoke,
    // exact context.expectedVersion и исходный durable request ID/ID/key.
    return send();
  },
});
// Подтвердить результат journal до следующего read/service.
```

Proof — непрозрачный одноразовый объект текущего session/job, не сериализуется и не
восстанавливается из old unknown journal. После crash/restart possession ID/key
не разрешает replay. При auth failure proof расходуется, journal остаётся unknown;
17 может отметить notSent только по доказательству отсутствия отправки.

`context` содержит baseVersion, expectedVersion, список подтверждённых собственных
authVersions и committed tuple. Ровно эти auth writes повышают version; чужая команда
не становится «своим refresh». Send дополнительно перечитывает authoritative state
и проверяет exact version/flags/tuple/expiry; второй send запрещён. Deadline и привязку
request/cycle непосредственно перед send проверяет journal owner. Прямая подмена
StdioRpc в нынешнем CycleEngine прежним callback до startup не является интеграцией:
соединение этих seams в CLI/workflow выполняет 17.

## GitHub storage и историческое доказательство ADR

`GitHubStorage` из 15 сохраняется: private repo, один AUTO_RESET_GITHUB_TOKEN,
Contents CAS с ref=auto-reset-state, previous blob SHA, version и полным readback.
Lost state PUT response допускает успех только при точном совпадении полного документа;
conflict не повторяется. State/Secret не являются одной транзакцией. Bootstrap ветки,
один общий workflow/setup writer и grants реализуются 17/18. PAT rotation требует
disable; `HostAuthAdmin.rotateGrant` не меняет историю. Delete bundle требует revoked+disabled.

Legacy AuthSession/fake barrier и ManagedAuthRuntime сохраняют evidence 15.
Официальный managed runtime не даёт положительного quiescence/save barrier:
synthetic rotation с auth.json 0400 возвращает успешный account response при потере
новых tokens; exit во время refresh также не подтверждает save. Эти stock проверки
сохраняются в contract suite как причина ADR-0001, а не production managed path.

## Проверки и границы

```sh
npm ci --ignore-scripts
npm test
npm run test:contract
```

Последний прогон: **142 offline passed, 8 stock checks skipped offline**;
**18 stock contract passed** на macOS с OS guard (только loopback fixture port,
desktop auth file reads запрещены). Linux namespace runner из 13/17 сохраняется.

Host suite проверяет crash cuts до/после local save/target/PUT/finalize и шесть SIGKILL
границ с настоящим disk journal; optional/malformed tokens, identity, expired/reused/
revoked grant, local/state/Secret failures, ambiguous PUT и exact recovery. Existing
history применяется при same/different reconnect и disabled setup. Проверены stale
protocol/bundle/PAT, чужая version/disable/expiry при startup, одноразовый consume proof.

Stock bridge использует настоящий synthetic HTTP OAuth backend и fake GitHub с
настоящим LibSodium encrypt/decrypt. Publication/readback завершены до child login;
account/read и selected consume работают без inference. Audit доказывает отсутствие
child OAuth, refresh/id/PAT в env/login stdin и managed файла в работающем home.
401 read/consume, lost consume, HTTP timeout после rotation и invalid external login
не вызывают refresh/replay. Unexpected external request/refusal проверен на настоящем
stdio child fixture через тот же StdioRpc; fixture не утверждает, что stock самостоятельно
создал такой запрос в успешном account-only сценарии.

23 подтверждает клиентский lifecycle и handoff seams. GitHub propagation/grants,
настоящие OAuth grant compatibility, login/rotation grace/expiry/reuse/family/revoke,
entitlement и применение пользовательского выданного сброса проверяет только 21.
Реальные credentials и реальные account действия для закрытия 23 не использовались.

## Интеграция 17

Реализован [private workflow](private-workflow.md): GitHub authoritative state после
общего writer slot, HostAccountAdapter/current-job reservation proof, `finalDispatch`
после последнего асинхронного auth read и `onResponse` до cleanup.
Final dispatch сохраняет exact version/deadline/disable/journal проверки engine;
OAuth intent/target/finalize допускаются только как подтверждённый собственный переход.
Локальный JSONL CLI остаётся synthetic; `private-cli.mjs` требует закрытый по умолчанию
пилотный gate. Linux/macOS stock evidence — в отчёте 17, реальные свойства — 21.
