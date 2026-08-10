/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from 'react';
import { Toolbar } from '@web/components/toolbar';
import { ToolbarButton, ToolbarSeparator } from '@web/components/toolbarButton';
import { Dialog } from './dialog';
import { PreferencesForm } from './preferencesForm';
import type { Source } from '@recorder/recorderTypes';
import { Recorder } from '@recorder/recorder';
import type { CrxSettings } from './settings';
import { addSettingsChangedListener, defaultSettings, loadSettings, removeSettingsChangedListener } from './settings';
import ModalContainer, { create as createModal } from 'react-modal-promise';
import { SaveCodeForm } from './saveCodeForm';
import './crxRecorder.css';
import './form.css';

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function generateDatetimeSuffix() {
  return new Date().toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
}

const codegenFilenames: Record<string, string> = {
  'javascript': 'example.js',
  'playwright-test': 'example.spec.ts',
  'java-junit': 'TestExample.java',
  'java': 'Example.java',
  'python-pytest': 'test_example.py',
  'python': 'example.py',
  'python-async': 'example.py',
  'csharp-mstest': 'Tests.cs',
  'csharp-nunit': 'Tests.cs',
  'csharp': 'Example.cs',
};

export const CrxRecorder: React.FC = ({
}) => {
  const [settings, setSettings] = React.useState<CrxSettings>(defaultSettings);
  // The vendored Recorder owns `sources` since 1.58. This popup keeps its own copy only
  // for the Save feature, which needs the selected source's text and a filename for it.
  const [sources, setSources] = React.useState<Source[]>([]);
  const [selectedFileId, setSelectedFileId] = React.useState<string>(defaultSettings.targetLanguage);

  // 1.58 reversed the direction of `window.dispatch`. It used to be how the UI sent events
  // out; it is now how the app pushes state IN, installed by the vendored Recorder, and
  // outgoing calls go through `window.sendCommand`. Both are assigned during render rather
  // than in an effect: React runs child effects before the parent's, and the Recorder
  // dispatches `setAutoExpect` from a mount effect — assigning in our effect left that
  // call hitting `undefined`, and a TypeError thrown from an effect unmounts the tree,
  // which is how the popup came up blank at 1.55.
  const portRef = React.useRef<chrome.runtime.Port>();
  const pendingRef = React.useRef<{ method: string, params?: any }[]>([]);
  window.sendCommand = async (data: { method: string, params?: any }) => {
    if (portRef.current)
      portRef.current.postMessage({ type: 'recorderEvent', event: data.method, params: data.params });
    else
      pendingRef.current.push(data);
    if (data.method === 'fileChanged')
      setSelectedFileId(data.params.fileId);
  };

  React.useEffect(() => {
    const port = chrome.runtime.connect({ name: 'recorder' });
    // Anything arriving before the Recorder's layout effect has installed `dispatch` would
    // be dropped, so it waits. In practice the first message is the initial setSources.
    const inbound: { method: string, params?: any }[] = [];
    const flush = () => {
      if (!window.dispatch)
        return;
      for (const data of inbound.splice(0))
        window.dispatch(data);
    };
    const toFrontend = (data: { method: string, params?: any }) => {
      inbound.push(data);
      flush();
    };

    const onMessage = (msg: any) => {
      if (!('type' in msg) || msg.type !== 'recorder')
        return;

      switch (msg.method) {
        case 'setPaused': toFrontend({ method: 'pauseStateChanged', params: { paused: msg.paused } }); break;
        case 'setMode': toFrontend({ method: 'modeChanged', params: { mode: msg.mode } }); break;
        case 'setSources':
          setSources(msg.sources);
          toFrontend({ method: 'sourcesUpdated', params: { sources: msg.sources } });
          break;
        case 'resetCallLogs': toFrontend({ method: 'callLogsReplaced', params: { callLogs: [] } }); break;
        case 'updateCallLogs': toFrontend({ method: 'callLogsUpdated', params: { callLogs: msg.callLogs } }); break;
        // Replaces the whole log atomically. Replay rebuilds its entries on every step,
        // so merging (as callLogsUpdated does) would accumulate stale ones.
        case 'setCallLogs': toFrontend({ method: 'callLogsReplaced', params: { callLogs: msg.callLogs } }); break;
        case 'elementPicked':
          toFrontend({ method: 'elementPicked', params: { elementInfo: msg.elementInfo, userGesture: msg.userGesture } });
          break;
      }
    };
    port.onMessage.addListener(onMessage);

    portRef.current = port;
    for (const data of pendingRef.current.splice(0))
      port.postMessage({ type: 'recorderEvent', event: data.method, params: data.params });

    loadSettings().then(settings => {
      setSettings(settings);
      setSelectedFileId(settings.targetLanguage);
    }).catch(() => {});

    addSettingsChangedListener(setSettings);

    return () => {
      removeSettingsChangedListener(setSettings);
      portRef.current = undefined;
      port.disconnect();
    };
  }, []);

  // 1.55 removed `isPrimary`/`timestamp` from Source, and with them the Recorder
  // component's fallback for choosing a file to display. It renders exactly the source
  // last revealed to it — and an empty editor before that. This popup owns the selection
  // (it comes from the saved target language), so it has to push it down; without this the
  // code panel stays blank until the user picks a language by hand.
  React.useEffect(() => {
    if (window.dispatch && sources.some(s => s.id === selectedFileId))
      window.dispatch({ method: 'sourceRevealRequested', params: { sourceId: selectedFileId } });
  }, [sources, selectedFileId]);

  const source = React.useMemo(() => sources.find(s => s.id === selectedFileId), [sources, selectedFileId]);

  const requestStorageState = React.useCallback(() => {
    if (!settings.experimental)
      return;

    chrome.runtime.sendMessage({ event: 'storageStateRequested' }).then(storageState => {
      const fileSuffix = generateDatetimeSuffix();
      download(`storageState-${fileSuffix}.json`, JSON.stringify(storageState, null, 2));
    });
  }, [settings]);

  const showPreferences = React.useCallback(() => {
    const modal = createModal(({ isOpen, onResolve }) =>
      <Dialog title='Preferences' isOpen={isOpen} onClose={onResolve}>
        <PreferencesForm />
      </Dialog>
    );
    modal().catch(() => {});
  }, []);

  const saveCode = React.useCallback(() => {
    if (!settings.experimental)
      return;

    const modal = createModal(({ isOpen, onResolve, onReject }) => {
      return <Dialog title='Save code' isOpen={isOpen} onClose={onReject}>
        <SaveCodeForm onSubmit={onResolve} suggestedFilename={codegenFilenames[selectedFileId]} />
      </Dialog>;
    });
    modal()
        .then(({ filename }) => {
          const code = source?.text;
          if (!code)
            return;

          download(filename, code);
        })
        .catch(() => {});
  }, [settings, source, selectedFileId]);

  React.useEffect(() => {
    if (!settings.experimental)
      return;

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveCode();
      }
    };
    window.addEventListener('keydown', keydownHandler);

    return () => {
      window.removeEventListener('keydown', keydownHandler);
    };
  }, [selectedFileId, settings, saveCode]);

  const dispatchEditedCode = React.useCallback((code: string) => {
    window.sendCommand({ method: 'codeChanged', params: { code } });
  }, []);

  const dispatchCursorActivity = React.useCallback((position: { line: number }) => {
    window.sendCommand({ method: 'cursorActivity', params: { position } });
  }, []);

  return <>
    <ModalContainer />

    <div className='recorder'>
      {settings.experimental && <>
        <Toolbar>
          <ToolbarButton icon='save' title='Save' disabled={false} onClick={saveCode}>Save</ToolbarButton>
          <div style={{ flex: 'auto' }}></div>
          <div className='dropdown'>
            <ToolbarButton icon='tools' title='Tools' disabled={false} onClick={() => {}}></ToolbarButton>
            <div className='dropdown-content right-align'>
              <a href='#' onClick={requestStorageState}>Download storage state</a>
            </div>
          </div>
          <ToolbarSeparator />
          <ToolbarButton icon='settings-gear' title='Preferences' onClick={showPreferences}></ToolbarButton>
        </Toolbar>
      </>}
      <Recorder onEditedCode={dispatchEditedCode} onCursorActivity={dispatchCursorActivity} />
    </div>
  </>;
};
