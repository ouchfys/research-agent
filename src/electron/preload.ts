import { contextBridge, ipcRenderer } from 'electron';
import type { ShelfAPI } from '../shared/types';
const api:ShelfAPI={
  call:(method,payload)=>ipcRenderer.invoke('shelf:call',method,payload),
  onEvent(listener){const handler=(_event:unknown,value:Parameters<typeof listener>[0])=>listener(value);ipcRenderer.on('shelf:event',handler);return()=>ipcRenderer.removeListener('shelf:event',handler);},
  chooseFiles:()=>ipcRenderer.invoke('shelf:choose-files'),
  chooseDirectory:()=>ipcRenderer.invoke('shelf:choose-directory'),
  importEnv:()=>ipcRenderer.invoke('shelf:import-env'),
  openPath:(path)=>ipcRenderer.invoke('shelf:open-path',path),
  openExternal:(url)=>ipcRenderer.invoke('shelf:open-external',url),
};
contextBridge.exposeInMainWorld('shelf',api);
