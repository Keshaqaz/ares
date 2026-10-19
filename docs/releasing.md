# Выпуск версии

Пользователь ставит программу из tap `Keshaqaz/homebrew-tap`:

```sh
brew install keshaqaz/tap/codex-auto-resets
```

Формула скачивает архив выпуска из GitHub Release этого репозитория. Архив — `npm pack` пакета: `prepack` собирает `dist/worker.mjs`, а `bundleDependencies` кладут внутрь libsodium. Поэтому `brew install` не запускает npm и не ходит в сеть, кроме загрузки архива. Единственная зависимость формулы — `node` из Homebrew.

Архив скачивается без авторизации, поэтому репозиторий и его выпуски должны быть публичными.

## Шаги

0. Первый выпуск закрыт воротами по замеру из [ADR-0004](adr/0004-github-only-worker.md): нужен результат `prototype/cron-lag`, и максимальный разрыв между запусками cron должен укладываться в 8 часов.
1. Поднимите `version` в `package.json`, закоммитьте и проверьте: `npm test`.
2. Соберите архив и формулу:

   ```sh
   npm run release:brew
   ```

   Скрипт печатает пути к `dist/codex-auto-resets-<версия>.tgz`, `dist/codex-auto-resets.rb` и sha256 архива.
3. Поставьте тег и опубликуйте выпуск с архивом:

   ```sh
   git tag v<версия> && git push origin v<версия>
   gh release create v<версия> dist/codex-auto-resets-<версия>.tgz --title v<версия> --notes "…"
   ```

   Имя файла в выпуске должно остаться `codex-auto-resets-<версия>.tgz`: на него указывает `url` формулы.
4. Скопируйте `dist/codex-auto-resets.rb` в `Formula/codex-auto-resets.rb` репозитория `Keshaqaz/homebrew-tap`, закоммитьте и запушьте.
5. Проверьте установку из tap:

   ```sh
   brew update
   brew install keshaqaz/tap/codex-auto-resets   # или brew upgrade
   brew test codex-auto-resets
   brew audit --strict --online codex-auto-resets
   codex-auto-resets --version
   ```

После `brew upgrade` пользователь обновляет воркер в своём репозитории командой `codex-auto-resets upgrade`.

## Проверка формулы до публикации

Формулу можно поставить из локального tap, подменив `url` на собранный архив:

```sh
brew tap-new keshaqaz/local --no-git
TAP=$(brew --repository keshaqaz/local)
sed "s#url \".*\"#url \"file://$PWD/dist/codex-auto-resets-$(node -p 'require("./package.json").version').tgz\"#" \
  dist/codex-auto-resets.rb > "$TAP/Formula/codex-auto-resets.rb"
HOMEBREW_NO_INSTALL_FROM_API=1 brew install keshaqaz/local/codex-auto-resets
brew test keshaqaz/local/codex-auto-resets
brew uninstall codex-auto-resets && brew untap keshaqaz/local
```

`brew audit --strict` на этом tap проходит офлайн; `--online` дополнительно проверяет, что `homepage` и `url` доступны.
