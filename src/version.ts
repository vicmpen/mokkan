/**
 * The CLI version, baked into the generated `init.<shell>` header (a changed version makes `notify poll` regenerate
 * it). A constant rather than a read of package.json, which the plugin bundle does not ship next to itself;
 * `test/notify-command.test.ts` keeps it equal to package.json's version.
 */
export const VERSION = '0.8.0';
