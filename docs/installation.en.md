# Installation and use

**English** · [Русский](installation.md)

The CLI speaks Russian; the messages quoted below are given in Russian with a translation.

## What you need

- A Mac. The worker itself runs on GitHub; the Mac is only for commands.
- A GitHub account. The free plan is enough.
- A paid ChatGPT subscription that issues rate-limit resets.

## Install

```sh
brew install keshaqaz/tap/codex-auto-resets
```

From source (Node 26 required):

```sh
git clone https://github.com/Keshaqaz/ares.git && cd ares
npm ci
npm run build:worker
node src/cli/main.mjs setup      # then use node src/cli/main.mjs in place of codex-auto-resets
```

## First setup

```sh
codex-auto-resets setup
```

1. **GitHub sign-in.** Open the link, enter the code and allow access. The sign-in is kept in the Keychain, so you won't be asked again.
2. **Repository.** A private repository `codex-auto-resets-worker` appears in your account. The worker lives there.
3. **ChatGPT sign-in.** Open the link, enter the code and sign in to the account with the resets. This sign-in belongs to the worker alone: Codex on your computer keeps working as before.
4. **Rules.** Choose when resets are applied (see below). Enter keeps the defaults.
5. **Check.** The CLI runs the worker once and shows the result:

   ```
   Воркер работает. Сбросов: 2, ближайший истекает 22 октября 2026 г. в 15:00 UTC.
   ```

   ("The worker is running. Resets: 2, the next one expires on 22 October 2026 at 15:00 UTC.")

If `setup` is interrupted, run it again: it picks up where it stopped and loses nothing.

## Rules

| Rule | Default | What it does |
| --- | --- | --- |
| Before expiry (last 8 hours) | on | Applies a reset when less than 8 hours are left before it expires. |
| When the weekly limit runs out | off | As soon as the worker sees the weekly limit is used up, applies the reset that expires first. |

The rules cover all resets at once and work independently. Change them any time with `codex-auto-resets rules`; new rules take effect from the next worker run.

The worker runs about once an hour, but GitHub sometimes delays runs by several hours, so the rules don't fire at an exact minute.

## Day to day

**Check that everything is fine:**

```sh
codex-auto-resets status
```

Shows the resets, the rules, the last run and the last application. If something is wrong, a line starting with «Внимание!» ("Warning!") at the bottom says what to do.

**Apply a reset right now:**

```sh
codex-auto-resets apply-now
```

Pick a reset by its number and confirm with `y`. The CLI waits for the worker and reports the result; this can take a few minutes. A reset is single-use, and applying it cannot be undone.

## When something breaks

When a worker run fails, GitHub emails you. Run `codex-auto-resets status`: it shows the cause and the fix. Common cases:

| Message | What to do |
| --- | --- |
| Воркер потерял вход в ChatGPT (the worker lost its ChatGPT sign-in) | `codex-auto-resets login` and sign in again. Rules and history are kept. |
| Воркер выключен в GitHub (the worker is disabled in GitHub) | Open the link in the message and click **Enable workflow**. |
| Воркер не запускался уже N ч (the worker hasn't run for N hours) | Open the link in the message and check that GitHub Actions is working. Runs usually resume on their own. |
| Это другой аккаунт ChatGPT (this is a different ChatGPT account) | Sign in to the account the worker was set up for. Switching accounts takes a reinstall: `uninstall`, then `setup`. |
| Установка не завершена (setup is not finished) | `codex-auto-resets setup`. |
| Воркер устарел (the worker is out of date) | `codex-auto-resets upgrade`. |

## Upgrade

```sh
brew upgrade codex-auto-resets
codex-auto-resets upgrade
```

The second command updates the worker in your repository; without it, the old version keeps running there. Rules, history and the ChatGPT sign-in are kept.

## Uninstall

```sh
codex-auto-resets uninstall
brew uninstall codex-auto-resets
```

`uninstall` asks you to sign in to GitHub once more: deleting a repository needs a separate permission, which the CLI does not keep. It then revokes the worker's ChatGPT sign-in, deletes the repository and removes the GitHub sign-in from the Keychain. Finally, open the GitHub page it links and click **Revoke** to close access completely.

## What is stored where

| Where | What |
| --- | --- |
| Keychain on your Mac | the GitHub sign-in (entry `codex-auto-resets`) |
| Repository `codex-auto-resets-worker` | the worker code, schedule, rules, an open summary (resets and their deadlines, no sign-in or account data) and the worker's encrypted ChatGPT sign-in |
| Secret `STATE_KEY` in the repository settings | the key that encrypts the worker's sign-in |

The GitHub sign-in gives the CLI access to all your repositories, like `gh`. The worker repository must stay private: if you make it public, the CLI refuses to work with it.

## What it costs

Nothing. GitHub Actions bills each worker run as at least one minute, which adds up to ~750 minutes a month. The GitHub Free plan includes 2,000 minutes a month for private repositories. If your other private repositories use Actions too, keep the total in mind.
