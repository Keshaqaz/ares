// The language of the CLI: English by default, Russian when the user picks it with `l` on
// the screen or with `aures language ru`. The choice lives on this Mac in
// settings.json next to the watch files.
export const LANGUAGES = ['en', 'ru'] as const;
export type Language = typeof LANGUAGES[number];
let current: Language = 'en';

export const isLanguage = (value: unknown): value is Language => LANGUAGES.some(code => code === value);
export const language = (): Language => current;
export const setLanguage = (value: unknown): void => { current = isLanguage(value) ? value : 'en'; };
// The text in the current language.
export const t = (en: string, ru: string): string => current === 'ru' ? ru : en;
