'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseRunKey, staleEntryNames } = require('../src/main/autostart');

const SAMPLE = [
  '',
  String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`,
  String.raw`    electron.app.Crosshair Z    REG_SZ    G:\cz\release\Crosshair Z 1.7.19.exe --hidden`,
  String.raw`    com.crosshairz.app    REG_SZ    G:\cz\release\Crosshair Z 1.8.3.exe --hidden`,
  String.raw`    Discord    REG_SZ    "C:\Users\x\AppData\Local\Discord\Update.exe" --processStart Discord.exe`,
  String.raw`    OldCopy    REG_EXPAND_SZ    %USERPROFILE%\Downloads\Crosshair-Z.exe --hidden`,
  '',
].join('\r\n');

test('parses reg query output', () => {
  const e = parseRunKey(SAMPLE);
  assert.strictEqual(e.length, 4);
  assert.deepStrictEqual(e[0], { name: 'electron.app.Crosshair Z', data: String.raw`G:\cz\release\Crosshair Z 1.7.19.exe --hidden` });
  assert.deepStrictEqual(parseRunKey(null), []);
});

test('every Crosshair Z entry except our own is stale; other apps untouched', () => {
  assert.deepStrictEqual(staleEntryNames(parseRunKey(SAMPLE), 'com.crosshairz.app'), ['electron.app.Crosshair Z', 'OldCopy']);
});
