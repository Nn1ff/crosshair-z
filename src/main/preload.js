'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'config:get',
  'config:patch',
  'profile:update',
  'profile:create',
  'profile:delete',
  'profile:activate',
  'profile:move',
  'profile:importMany',
  'profile:dedupe',
  'cx:scan',
  'cx:openFile',
  'displays:list',
  'hotkeys:set',
  'hotkeys:suspend',
  'clipboard:write',
  'clipboard:read',
  'log:path',
]);
const EVENT_CHANNELS = new Set(['config:changed', 'overlay:render', 'overlay:fire', 'hotkeys:status', 'runtime:changed']);

contextBridge.exposeInMainWorld('cz', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`blocked channel ${channel}`);
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
