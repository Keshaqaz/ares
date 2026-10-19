// The language of the CLI: English by default, Russian when the user picks it with `l` on
// the screen or with `codex-auto-resets language ru`. The choice lives on this Mac in
// settings.json next to the watch files.
export const LANGUAGES = ['en', 'ru'];
let current = 'en';

export const language = () => current;
export const setLanguage = value => { current = LANGUAGES.includes(value) ? value : 'en'; };
// The text in the current language.
export const t = (en, ru) => current === 'ru' ? ru : en;
