# Installation on macOS

Use Node **26.10.0** and the official Codex **0.160.1** binary. Verified behavior
and known limitations are listed in the [support table](support.md). The installer prompts for
Russian or English and provides both terminal interfaces.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run install:macos
```

**Setup wizard (`i`).** After the language, repo and installation token, the installer walks
you through the steps below in a row: `1` Install → ChatGPT login (`2`, `3` after a revoke or
reconnect, then `4`) → quota (`q`, `b`) → external timer (`c`, waiting for the probe). Before each
step: Enter runs it, `0` returns to the menu. Progress is read from the state, so an interrupted
wizard (exit, a failed step, an unfinished command, which Resume settles first) continues from the
first unfinished step on the next run or with `i` in the menu; it keeps waiting for a probe still
inside its grace and offers `c` again for a missed one. It starts by itself only while the
installation is paused (or not created yet) and a step is left. It ends with "setup is complete":
the rules (`m`, `w`, `5`) and enabling with `6` behind the `AUTO_RESET_PILOT_APPROVED` gate stay
your own separate decision. Every menu item below remains available by hand.

1. Create a dedicated private GitHub repository with a README. Then issue the
   **installation token**, the only token you create yourself
   ([ADR-0003](adr/0003-single-token-timer-app.md)): leave the token prompt blank and
   the installer opens a prefilled GitHub form with a name, 366 days and Contents,
   Secrets, Actions, Variables, Workflows — write plus Plan: read. Select the repo,
   click Generate and paste the token (hidden). It serves the repo and billing; see
   [Installation token](#installation-token). Administration permission is unnecessary.
   The external timer uses a second, narrow token (see below); the installation token
   never leaves GitHub.
2. `1 Install` publishes an immutable program commit, a workflow with only the static
   daily fallback cron `41 5 * * *`, and an empty timer plan
   `.auto-reset-timer-plan.json`; the shared Actions writer initializes disabled
   durable state.
3. `2 Login/reconnect` performs an isolated interactive ChatGPT CI login using the
   official binary. Desktop credentials are not copied. The host owns refresh;
   the runner's App Server receives only an access token.
4. `3 Confirm new login`, then `4 Check` confirm the separate session and metadata
   while disabled. A different account/user requires a separate installation.
5. `q Set up quota` while paused asks only for confirmation of an account-wide Actions
   budget of $0 and Stop usage: Yes and the plan; billing is read with the installation
   token (Plan: read). `b Check quota` reads the saved configuration in a new Actions job. Repeat
   setup after a budget/plan change. The API does not verify your personal budget
   or guarantee a billing ceiling; see [billing](github-billing.md).
6. `5 Select reset` chooses an eligible ID and interval before expiry (default
   60 minutes). Missing/no expiry requires an explicit start; the cycle then
   lasts at most one hour. Partial metadata requires an explicit visible ID.
7. While paused (`7 Pause`), `w Weekly auto reset` accepts YES to enable or NO to
   disable the saved option. It defaults to false, including migration. It
   permits consumption only with fresh account-bound weekly exhaustion before
   weekly renewal. Five-hour exhaustion alone is insufficient. Enabling this
   option does not enable the schedule.
8. `c External timer` deploys the Cloudflare Worker and confirms it with a probe
   (below). Without a confirmed timer, enable fails with `timer_confirmation_required`;
   the timer app has no expiry, so enable checks none.
9. `6 Enable/resume` requires the live-consume gate — the repository variable
   `AUTO_RESET_PILOT_APPROVED` set to `owner/repo`. The installer never sets it; the
   owner creates it (Settings → Secrets and variables → Actions → Variables) after
   reading the [support table](support.md). It also requires confirmed client/persistence/cost
   prerequisites, a checked session, a confirmed external timer, and fresh quota
   admission. Attempts start at the selected time and run at five-minute slots
   woken by the timer until success/deadline. Neither Cloudflare nor GitHub
   promises punctuality; a run can be late or missing. A cycle from `5 Select` keeps the
   weekly guard; manual apply-now/retry (from 14 October) does not. Unknown consume outcomes
   stop further consumption.
10. `m Monitor` is an inline interactive screen in the ordinary terminal flow (no alternate
   screen; without a TTY one snapshot is printed). "Issued resets" lists the latest read with
   expiry dates and cycle state; "Global rules" holds two checkboxes for all resets, both off
   by default: "30 minutes before expiry" (no weekly-quota condition) and "automatically when
   the weekly quota is exhausted" (the reset with the nearest expiry right after confirmed
   exhaustion; at 99% the timer checks more often for an hour). `↑↓` select, `Enter` — "Apply
   now" confirmed with `y` (an attempt cycle from now, without rule conditions) or enter the
   rules block, `Enter`/`Space` — toggle, `Esc` — leave, `2` — status and journal, `r` —
   refresh/re-check an unconfirmed command, `q` — back to the menu. Monitor commands travel as
   sealed control and need no pause; apply-now needs an enabled installation. An accepted
   command is not an application.

## External timer

GitHub does not promise `on: schedule` delivery; none of 39 slots arrived during our
observation on 9–10 October 2026. Attempt windows are therefore woken by an external
timer ([ADR-0002](adr/0002-external-timer.md)): a Cloudflare Worker on the free plan
ticks every five minutes (`2-57/5 * * * *`), reads `.auto-reset-timer-plan.json` on
`main`, and sends an empty `workflow_dispatch` without inputs only in its minutes.
The decision to apply, retries, deadlines and the early-consume guard stay in the
private workflow, so a late or double tick is an ordinary reconcile. The native cron
is only a daily fallback that reports `external_timer_stale` in the Summary.

Run `c External timer` while paused. The Worker reaches GitHub through the **timer
app** — a GitHub App in your own account ([ADR-0003](adr/0003-single-token-timer-app.md));
there is no token to copy, only two clicks in GitHub:

1. Create a free Cloudflare account (Workers Free); 288 invocations a day are far
   below its limits.
2. **Create.** The installer serves a local page on `127.0.0.1` with a random port and
   opens it; the page posts the app manifest to GitHub (`auto-reset-timer-<6 hex>`,
   **Actions: write** and **Contents: read**, webhook off — placeholder URL
   `https://example.invalid/…` with `active: false`). Click **Create GitHub App**: GitHub
   sends the browser back with a one-time code, the installer checks `state` and
   exchanges the code for the app key within the hour. The local server closes right
   after the exchange or after 15 minutes. If the browser is signed in to another GitHub
   account, the step stops (`timer_app_owner_mismatch`) and links the app created there
   for deletion.
3. **Install.** The installer opens the install link, which does not preselect the repo:
   choose **Only select repositories** → the installation repo, click **Install** and
   answer YES. The installer finds the installation ID with the app JWT
   (`GET /repos/{owner}/{repo}/installation`) and asks again while it is missing. An
   installation on all repos is **reported and accepted**: the Worker narrows every token
   to the installation repo, but a leaked key would reach all repos (below).
4. The installer issues the same narrow installation token as the Worker, reads the
   repository and the plan with it (a matching private repository, `main` as the default
   branch) and revokes the token at once.
5. Deployment: `npx --yes wrangler@4.139.0 deploy` with `--var` `REPOSITORY`,
   `TIMER_APP_ID`, `TIMER_INSTALLATION_ID` (Wrangler opens a Cloudflare browser login;
   `CLOUDFLARE_API_TOKEN` works without a browser), then `secret put TIMER_APP_KEY`. If
   Wrangler fails, the installer offers a retry while the key is still in memory. The
   Worker imports shared `src/` modules, so Wrangler always uploads the code.
6. The sealed `timer` admin command carries only the App ID, slug and installation ID.
   The writer stores them in `installation.timer` and publishes a plan with a single
   probe slot on the timer grid 15–20 minutes ahead (Cron Trigger changes propagate
   within 15 minutes).
7. The Worker dispatches in that slot and the run appears in Actions. That run, if it
   starts within 30 minutes of the slot, marks the timer confirmed and drops the probe
   from the plan. While the `AUTO_RESET_PILOT_APPROVED` gate is closed, an empty dispatch only
   reconciles and confirms the probe, like the fallback, with no account read. If it
   is not confirmed, check `wrangler tail`, the `TIMER_APP_KEY` secret and the app
   installation, and repeat `c` (each repeat creates a new app; delete the old one from
   the link the installer prints); pausing abandons an unconfirmed probe.

If the step stops after Create, the app stays in GitHub: the installer prints
`https://github.com/settings/apps/<slug>/advanced` → **Delete GitHub App**.

`s Status` shows `timer`, `lastExternalWake` and `timerApp` (slug and installation ID).
The timer has no expiry, reminder or rotation.

**Moving from the timer token.** An installation set up before ticket 42 runs on a
fine-grained PAT in the `TIMER_TOKEN` secret; `s` shows `timerApp: timer token until … (c)`
and the installer reminds you at start and in `s`. Run `7 Pause` → `c` → `6`. Repeating
`c` writes `TIMER_APP_KEY` and the new vars, deletes the `TIMER_TOKEN` secret (Wrangler
asks to confirm; on failure the installer prints the manual command), and the writer
replaces the timer record as a whole — the token expiry leaves state — with a new probe.
Once the probe is confirmed, revoke the old timer token in GitHub. Until then the timer
keeps running on the token: enable checks no expiry, and an expired token is caught by the
fallback run (`external_timer_stale`).

**Third-party service and key storage.** Cloudflare is a service outside GitHub with its
own account. The **timer key** — the app's private key — is stored only as the encrypted
Worker secret `TIMER_APP_KEY` (PKCS#8 as one base64 line), which Wrangler and the
Dashboard never show again. GitHub issues the key as PKCS#1; the installer converts it to
PKCS#8 in memory and pipes it to Wrangler over stdin, never in arguments, environment,
files, the installer journal, state or logs. The `client_secret` and `webhook_secret` in
GitHub's answer are not kept. Without a live token the Worker signs a JWT (RS256,
WebCrypto) and obtains a one-hour installation token for the installation repo only, with
Actions: write and Contents: read; its log holds neither key nor token. The installation
token, Repository Secrets, the ChatGPT session and state never reach Cloudflare. The key
has no expiry; revocation replaces it. A leaked key can issue the app's installation
tokens — start, cancel and disable the workflow and read the repository (state without
credentials), in every repo of the owner if the app is installed on all repos — but cannot
pass commands: dispatch accepts only an empty input, exact status or an admin command
sealed with the installation token. On a suspected leak delete the key on the app page
(Private keys) or the app itself; a new key is generated there by hand and written per
`k Tokens` → "Timer key" (see [Tokens](#tokens-k)) — GitHub issues no app keys through the API.

`s Status` displays the saved option, disabled flag, quota, timer and cycle status.
`r Resume` redelivers the exact pending command ID/payload; HTTP dispatch alone
is not proof of durable acceptance. Check Actions Summary and the command journal.
The local journal defaults to `~/.config/auto-reset/installer.json` (0600), with
`AUTO_RESET_INSTALLER_JOURNAL` available for a separate installation. The installation
token never enters the journal: it is kept in the macOS Keychain (see
[Installation token](#installation-token)), so a restart does not ask for it.

## Installation token

The prefilled form is `https://github.com/settings/personal-access-tokens/new` with
`name`, `description`, `expires_in=366`, `contents`, `secrets`, `actions`,
`actions_variables`, `workflows` = `write` and `plan` = `read`. It sets no repository:
you select it. Workflows is used only by `1 Install` and `8 Upgrade`; Plan: read reads the
owner's plan and monthly usage. The form guarantees neither the expiry nor a single repo
(ticket 39), so the installer checks the issued token with the token itself: a private,
matching repo; read probes of the Secrets public key, Variables, Workflows and Contents
(Workflows write is proven by publishing the workflow); Plan: read through `/user` and the
billing usage summary (required for a new installation and `k → 1`, otherwise a warning); and
the expiry from `GitHub-Authentication-Token-Expiration`. An expired token is refused. A
shorter expiry is accepted with its date and a hint to reissue for 366 days. Access to
other private repos is a warning, not a refusal; reissuing with **Only select
repositories** is safer, because the token can write to every repo it reaches.

The expiry is kept in state (`installation.grant.expiresAt`, sent by `init` and `k → 1`). The
installer at start, `s` and Actions Summary remind you 14 days before expiry.

**Local storage.** The accepted token is saved in the login Keychain as a generic password,
service `auto-reset`, account `owner/repo`. `/usr/bin/security -i` receives it only on
stdin, never in arguments, environment or files. At start the stored token passes the same
checks; if GitHub rejects it (expired, revoked), the installer asks for a new one and
replaces the entry. If the Keychain is unavailable (access refused, no answer in 2 minutes),
the token is typed hidden and not saved that run. A confirmed `k → 1` replaces the entry; a
confirmed `9 Uninstall` removes it. To remove it by hand:
`security delete-generic-password -s auto-reset -a owner/repo`, or Keychain Access → search
`auto-reset` → delete.

**Installation token expired.** Jobs stop before reading state, and Actions Summary names
the cause. `k → 1` no longer helps, because the job runs with the old Secret. Issue a new token,
write it to the repository Secret `AUTO_RESET_GITHUB_TOKEN` (Settings → Secrets and
variables → Actions → Update), start the installer (GitHub rejects the Keychain token, so
enter the new one when asked), `7 Pause` if needed, then `k → 1`
with the same new token: the writer rebinds the session to it and stores its expiry.

## Tokens (`k`)

`k Tokens` shows every credential of the installation in one table (boxed on a terminal,
`|`-separated lines without a TTY):

```
#  Access               Stored in           Expires      State
1  Installation token   Keychain + Secret   2027-10-14   ✓
2  Timer key            Cloudflare secret   —            ✓ confirmed
3  ChatGPT session      Secret (bundle)     auto         ✓
```

A state starting with `!` needs action: the installation token expires within 14 days or
lacks Plan: read; the timer probe is unconfirmed or the timer still runs on the timer token
(`c`); the session needs a new login (`2`). While such a row exists the menu shows
`k Tokens !`. A row number and Enter run its action; a blank line goes back:

1. **Installation token** — paused (`7`), with no unfinished command: prefilled form → the
   checks above → `rotate-grant` → once confirmed, the new token in the Keychain and a
   reminder to revoke the old one in GitHub. Then `6`.
2. **Timer key** — hot swap with no pause, probe or re-enable: the installer opens
   `https://github.com/settings/apps/<slug>` → **Private keys → Generate a private key**,
   asks for the path to the downloaded `.pem` (you can drop the file into the window),
   converts it to PKCS#8 in memory and checks it: the new key's JWT must find the same app
   installation that state names, and the narrow installation token must read the repo and
   the plan. Only then the key goes to `wrangler secret put TIMER_APP_KEY` over stdin; vars,
   Worker code, state and plan are unchanged and no admin command is sent. The installer
   shows the new key's fingerprint (`SHA256:…`, as on the app page), reminds you to delete
   every previous key there, and offers to delete the downloaded file (`YES`). A previous
   key stays valid until you delete it. A timer still on the timer token is pointed to
   `7 → c → 6`; without an app, to step `c`.
3. **ChatGPT session** — the same as `2 Login/reconnect` (paused), then `3`.

## Pause, upgrade and uninstall

`7 Pause` disables new attempts and publishes an empty timer plan, abandoning an
unconfirmed probe. Failed cleanup remains unconfirmed; existing queued jobs can still
spend runner minutes, and the daily fallback keeps reconciling (up to 30 jobs a month). Resuming retains
the original cycle boundaries and requires fresh admission.

`8 Upgrade` pauses first, publishes explicit local source, applies supported
state migration (from a version with a separate billing token, the first admin command
removes the `AUTO_RESET_BILLING_TOKEN` Secret and resets the quota check: `k → 1` if warned
about Plan: read, then `b`, and revoke the old billing token), and replaces the pinned workflow with the target commit's template
(only the static fallback; managed cron from older pins disappears). Check and
Enable are separate steps. Auth/history come from authoritative storage, never
from an old checkout. Rolling back must not restore old refresh credentials or
clear applied/unknown history; an incompatible schema fails closed.

`k Tokens` → "Installation token" requires pause; a blank prompt opens the prefilled form,
and the new token passes the checks above and carries its expiry. Wait for confirmed
replacement before revoking the old token: until then the Keychain keeps the old one for
Resume. The confirmed result, in the same or a later run, switches the installer to the new
token and stores it in the Keychain (without a Keychain, type it on the next run).

`9 Uninstall` requires DELETE: durable disable/revoke, settle any preceding RPC,
empty the timer plan and forget the timer, remove the auth and installation token Secrets
and the billing policy, then disable the workflow so the fallback stops. History is retained. The
confirmed result removes the Keychain entry (or prints the manual command), and the
installer then offers `wrangler delete` for the timer Worker and prints the timer app's
deletion link (`https://github.com/settings/apps/<slug>/advanced` → Delete GitHub App).
Delete the app; revoke the installation token, any old billing and timer tokens, and the
separate ChatGPT CI session with the respective providers. Repository deletion is a separate manual step.
A local revoked marker or account/logout does not prove remote refresh cessation.

[Detailed Russian guide](installation.md), [cycle commands](reset-cycle-state.md),
[host-owned auth](auth-storage.md), [private workflow](private-workflow.md).
