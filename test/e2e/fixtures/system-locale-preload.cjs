// Process-local system-language input for first-boot locale cases. Chromium's
// --lang controls browser language, but Windows keeps its OS language list.
const { app } = require('electron');
const locale = process.env.ORKAS_E2E_SYSTEM_LOCALE;
if (locale) app.getPreferredSystemLanguages = () => [locale];
