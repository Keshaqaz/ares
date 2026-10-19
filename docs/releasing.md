# Выпуск версии

Пользователь ставит программу из tap `Keshaqaz/homebrew-tap`:

```sh
brew install keshaqaz/tap/aures
```

Формула скачивает архив выпуска из GitHub Release этого репозитория. Архив — `npm pack` пакета: `prepack` собирает `dist/worker.mjs`, а `bundleDependencies` кладут внутрь libsodium. Поэтому `brew install` не запускает npm и не ходит в сеть, кроме загрузки архива. Единственная зависимость формулы — `node` из Homebrew.

Архив скачивается без авторизации, поэтому репозиторий и его выпуски должны быть публичными.

Агент launchd проверки с Mac (ADR-0005) запускает `<prefix>/opt/aures/bin/aures watch`. Ссылка `opt` после `brew upgrade` указывает на новую версию, поэтому формуле ничего добавлять не нужно. `agentProgram` в `src/cli/launch-agent.mjs` узнаёт установку Homebrew по пути `…/Cellar/aures/<версия>/libexec/src/cli/main.mjs`, который задаёт обёртка формулы. Если формула меняет `libexec` или имя файла в `bin`, поменяйте `agentProgram` вместе с ней: `test/brew-release.test.mjs` сверяет их.

## Шаги

0. Первый выпуск закрыт воротами по замеру из [ADR-0004](adr/0004-github-only-worker.md): нужен результат `prototype/cron-lag`, и максимальный разрыв между запусками cron должен укладываться в 8 часов.
1. Поднимите `version` в `package.json`, закоммитьте и проверьте: `npm test`.
2. Соберите архив и формулу:

   ```sh
   npm run release:brew
   ```

   Скрипт печатает пути к `dist/aures-<версия>.tgz`, `dist/aures.rb` и sha256 архива.
3. Поставьте тег и опубликуйте выпуск с архивом:

   ```sh
   git tag v<версия> && git push origin v<версия>
   gh release create v<версия> dist/aures-<версия>.tgz --title v<версия> --notes "…"
   ```

   Имя файла в выпуске должно остаться `aures-<версия>.tgz`: на него указывает `url` формулы.
4. Скопируйте `dist/aures.rb` в `Formula/aures.rb` репозитория `Keshaqaz/homebrew-tap`, закоммитьте и запушьте. До 0.3.0 формула называлась `codex-auto-resets`: `formula_renames.json` в tap переводит старые установки на `aures`, его не удаляйте.
5. Проверьте установку из tap:

   ```sh
   brew update
   brew install keshaqaz/tap/aures   # или brew upgrade
   brew test aures
   brew audit --strict --online aures
   aures --version
   ```

   Если на этом Mac включено недельное правило, проверьте, что агент запускает программу через `opt`-путь, а не через папку версии:

   ```sh
   plutil -extract ProgramArguments json -o - ~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist
   ```

После `brew upgrade` пользователь обновляет воркер в своём репозитории командой `aures upgrade`.

## Проверка формулы до публикации

Формулу можно поставить из локального tap, подменив `url` на собранный архив:

```sh
brew tap-new keshaqaz/local --no-git
TAP=$(brew --repository keshaqaz/local)
sed "s#url \".*\"#url \"file://$PWD/dist/aures-$(node -p 'require("./package.json").version').tgz\"#" \
  dist/aures.rb > "$TAP/Formula/aures.rb"
HOMEBREW_NO_INSTALL_FROM_API=1 brew install keshaqaz/local/aures
brew test keshaqaz/local/aures
brew uninstall aures && brew untap keshaqaz/local
```

`brew audit --strict` на этом tap проходит офлайн; `--online` дополнительно проверяет, что `homepage` и `url` доступны.
