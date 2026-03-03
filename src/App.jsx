import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SkillLog from './components/SkillLog.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import StatusFeed from './components/StatusFeed.jsx';
import { useDemoRecorder } from './hooks/useDemoRecorder.js';
import { useWorkRecorder } from './hooks/useWorkRecorder.js';

const MODES = {
  DEMO: 'demo',
  WORK: 'work'
};
const DEMO_STAGE = {
  CAPTURE: 'capture',
  REVIEW: 'review'
};

const INITIAL_SETTINGS_DRAFT = {
  openrouterKey: '',
  googleKey: '',
  elevenlabsKey: '',
  elevenlabsVoiceId: '',
  debugMode: false
};

function toFeedItem(type, message) {
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, type, message };
}

async function playAudioFromBase64(audioBase64, mimeType = 'audio/mpeg') {
  if (!audioBase64) return;
  const binary = window.atob(audioBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const audio = new Audio(objectUrl);
    await audio.play();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function settingsToDraft(next = {}) {
  return {
    ...INITIAL_SETTINGS_DRAFT,
    debugMode: Boolean(next.debugMode)
  };
}

export default function App() {
  const ua = typeof window !== 'undefined' ? window.ua : undefined;
  const [mode, setMode] = useState(MODES.WORK);
  const [statusItems, setStatusItems] = useState([]);
  const [skills, setSkills] = useState([]);
  const [settings, setSettings] = useState({});
  const [settingsDraft, setSettingsDraft] = useState(INITIAL_SETTINGS_DRAFT);
  const [settingsTouched, setSettingsTouched] = useState({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [deletingSkillId, setDeletingSkillId] = useState('');
  const [processing, setProcessing] = useState(false);
  const [executionRunning, setExecutionRunning] = useState(false);
  const [demoStage, setDemoStage] = useState(DEMO_STAGE.CAPTURE);
  const [demoAwaitingConfirmation, setDemoAwaitingConfirmation] = useState(false);
  const [demoReviewBusy, setDemoReviewBusy] = useState(false);
  const [demoCanFinalize, setDemoCanFinalize] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatComposerOpen, setChatComposerOpen] = useState(false);
  const previousModeRef = useRef(null);
  const isDemoRecordingRef = useRef(false);
  const stopDemoAndFlushRef = useRef(async () => {});

  const appendStatus = useCallback((type, message) => {
    setStatusItems((prev) => [...prev.slice(-59), toFeedItem(type, message)]);
  }, []);

  const refreshSkills = useCallback(async () => {
    if (!ua) return;
    const result = await ua.listSkills();
    setSkills(result.skills || []);
  }, [ua]);

  const refreshSettings = useCallback(async () => {
    if (!ua) return;
    const next = await ua.getSettings();
    setSettings(next || {});
    setSettingsDraft(settingsToDraft(next || {}));
    setSettingsTouched({});
  }, [ua]);

  const processSegment = useCallback(
    async (audioBase64, segmentMode, audioFormat = 'webm', demoStageContext = null) => {
      if (!ua) throw new Error('Electron bridge unavailable (window.ua missing).');
      appendStatus(
        'status',
        `Sending audio segment for processing (mode=${segmentMode}, format=${audioFormat}${demoStageContext ? `, stage=${demoStageContext}` : ''}).`
      );
      const result = await ua.processVoice(audioBase64, segmentMode, audioFormat, demoStageContext);
      appendStatus(
        result.error ? 'error' : 'status',
        result.error
          ? `Voice processing returned an error (mode=${segmentMode}).`
          : `Voice processing completed (mode=${segmentMode}).`
      );
      if (result.transcript) appendStatus('transcript', result.transcript);
      if (result.response) appendStatus('agent', result.response);
      if (segmentMode === MODES.DEMO && typeof result.awaitingConfirmation === 'boolean') {
        setDemoAwaitingConfirmation(result.awaitingConfirmation);
      }
      if (result.skillWritten) {
        await refreshSkills();
        if (segmentMode === MODES.DEMO) {
          setDemoStage(DEMO_STAGE.CAPTURE);
          setDemoAwaitingConfirmation(false);
        }
      }
      if (result.ttsAudioBase64) {
        await playAudioFromBase64(result.ttsAudioBase64, result.ttsMimeType || 'audio/mpeg');
      }
      return result;
    },
    [appendStatus, refreshSkills, ua]
  );

  const processText = useCallback(
    async (text) => {
      if (!ua) throw new Error('Electron bridge unavailable (window.ua missing).');
      if (mode !== MODES.WORK) {
        throw new Error('Text input is currently available only in Work mode.');
      }
      const trimmed = text.trim();
      if (!trimmed) return null;

      appendStatus('status', 'Sending text command for processing (mode=work).');
      const result = await ua.processText(trimmed, MODES.WORK);
      appendStatus(
        result.error ? 'error' : 'status',
        result.error ? 'Text processing returned an error (mode=work).' : 'Text processing completed (mode=work).'
      );
      if (result.response) appendStatus('agent', result.response);
      if (result.ttsAudioBase64) {
        await playAudioFromBase64(result.ttsAudioBase64, result.ttsMimeType || 'audio/mpeg');
      }
      return result;
    },
    [appendStatus, mode, ua]
  );

  const { isRecording: isDemoRecording, toggle: toggleDemoRecording, stopAndFlush: stopDemoAndFlush } =
    useDemoRecorder({
      onLog: (message, type = 'status') => appendStatus(type, message),
      onSegment: async (audioBase64, audioFormat) => {
        try {
          await processSegment(audioBase64, MODES.DEMO, audioFormat, DEMO_STAGE.CAPTURE);
        } catch (error) {
          appendStatus('error', `Demo segment failed: ${error.message}`);
        }
      }
    });

  useEffect(() => {
    isDemoRecordingRef.current = isDemoRecording;
  }, [isDemoRecording]);

  useEffect(() => {
    stopDemoAndFlushRef.current = stopDemoAndFlush;
  }, [stopDemoAndFlush]);

  const { isListening: isDemoReplyListening, startListening: startDemoReply, stopListening: stopDemoReply } =
    useWorkRecorder({
      enableStopWordDetection: false,
      onInterrupt: undefined,
      onRecording: async (audioBase64, audioFormat) => {
        try {
          setProcessing(true);
          await processSegment(audioBase64, MODES.DEMO, audioFormat, DEMO_STAGE.REVIEW);
        } catch (error) {
          appendStatus('error', `Demo review reply failed: ${error.message}`);
        } finally {
          setProcessing(false);
        }
      }
    });

  const { isListening, startListening, stopListening } = useWorkRecorder({
    enableStopWordDetection: executionRunning,
    onLog: (message, type = 'status') => appendStatus(type, message),
    onInterrupt: async () => {
      appendStatus('interrupt', 'Stop word detected. Interrupting current execution task.');
      if (ua) await ua.interruptExecution();
    },
    onRecording: async (audioBase64, audioFormat) => {
      try {
        setProcessing(true);
        appendStatus('status', 'Thinking...');
        await processSegment(audioBase64, MODES.WORK, audioFormat);
      } catch (error) {
        appendStatus('error', `Work command failed: ${error.message}`);
      } finally {
        setProcessing(false);
      }
    }
  });

  useEffect(() => {
    if (!ua) {
      appendStatus(
        'error',
        'Electron preload bridge is unavailable. Restart dev app and ensure Electron window is used.'
      );
      return;
    }

    refreshSkills();
    refreshSettings();

    const unsubscribeStatus = ua.onStatus((payload) => {
      appendStatus(payload.type || 'status', payload.message);
    });

    const unsubscribeExecution = ua.onExecutionState((payload) => {
      setExecutionRunning(Boolean(payload.running));
    });

    return () => {
      unsubscribeStatus?.();
      unsubscribeExecution?.();
    };
  }, [appendStatus, refreshSettings, refreshSkills, ua]);

  useEffect(() => {
    if (!ua) return;
    let cancelled = false;

    const syncMode = async () => {
      if (mode === MODES.DEMO) {
        setDemoStage(DEMO_STAGE.CAPTURE);
        setDemoAwaitingConfirmation(false);
        setDemoCanFinalize(false);
        try {
          await ua.startDemo();
        } catch (error) {
          if (!cancelled) appendStatus('error', error.message);
        }
      } else if (previousModeRef.current === MODES.DEMO) {
        try {
          if (isDemoRecordingRef.current) {
            appendStatus('status', 'Switching out of demo: stopping recording and flushing final segment.');
            await stopDemoAndFlushRef.current();
          }
          await ua.endDemo();
        } catch (error) {
          if (!cancelled) appendStatus('error', `Failed to end demo mode cleanly: ${error.message}`);
        }
        if (!cancelled) {
          setDemoStage(DEMO_STAGE.CAPTURE);
          setDemoAwaitingConfirmation(false);
          setDemoCanFinalize(false);
        }
      }
    };

    syncMode();
    previousModeRef.current = mode;
    return () => {
      cancelled = true;
    };
  }, [mode, appendStatus, ua]);

  const finalizeDemoCapture = useCallback(async () => {
    if (!ua || demoReviewBusy || !demoCanFinalize) return;
    setDemoReviewBusy(true);
    try {
      if (isDemoRecording) {
        appendStatus('status', 'End Demo requested: stopping recording and flushing final segment.');
        await stopDemoAndFlush();
      }

      const result = await ua.finalizeDemo();
      if (result.response) appendStatus('agent', result.response);
      setDemoAwaitingConfirmation(Boolean(result.awaitingConfirmation));
      setDemoStage(DEMO_STAGE.REVIEW);
      setDemoCanFinalize(false);
      if (result.skillWritten) await refreshSkills();
      if (result.ttsAudioBase64) {
        await playAudioFromBase64(result.ttsAudioBase64, result.ttsMimeType || 'audio/mpeg');
      }
    } catch (error) {
      appendStatus('error', `Demo finalize failed: ${error.message}`);
    } finally {
      setDemoReviewBusy(false);
    }
  }, [appendStatus, demoCanFinalize, demoReviewBusy, isDemoRecording, refreshSkills, stopDemoAndFlush, ua]);

  const createSkillFromReview = useCallback(async () => {
    if (!ua || demoReviewBusy) return;
    setDemoReviewBusy(true);
    try {
      const result = await ua.saveDemoSkill();
      if (result.response) appendStatus('agent', result.response);
      setDemoAwaitingConfirmation(Boolean(result.awaitingConfirmation));
      if (result.skillWritten) {
        await refreshSkills();
        setDemoStage(DEMO_STAGE.CAPTURE);
        setDemoCanFinalize(false);
      }
      if (result.ttsAudioBase64) {
        await playAudioFromBase64(result.ttsAudioBase64, result.ttsMimeType || 'audio/mpeg');
      }
    } catch (error) {
      appendStatus('error', `Create skill failed: ${error.message}`);
    } finally {
      setDemoReviewBusy(false);
    }
  }, [appendStatus, demoReviewBusy, refreshSkills, ua]);

  const saveSettings = useCallback(async () => {
    if (!ua) return;
    setSettingsSaving(true);
    setSettingsError('');
    try {
      const payload = { debugMode: settingsDraft.debugMode };
      if (settingsTouched.openrouterKey) payload.openrouterKey = settingsDraft.openrouterKey;
      if (settingsTouched.googleKey) payload.googleKey = settingsDraft.googleKey;
      if (settingsTouched.elevenlabsKey) payload.elevenlabsKey = settingsDraft.elevenlabsKey;
      if (settingsTouched.elevenlabsVoiceId) payload.elevenlabsVoiceId = settingsDraft.elevenlabsVoiceId;
      const result = await ua.setSettings(payload);
      if (result?.settings) {
        setSettings(result.settings);
        setSettingsDraft(settingsToDraft(result.settings));
        setSettingsTouched({});
      }
      appendStatus('status', 'Settings saved.');
      await refreshSkills();
    } catch (error) {
      setSettingsError(error.message);
      appendStatus('error', `Failed to save settings: ${error.message}`);
    } finally {
      setSettingsSaving(false);
    }
  }, [appendStatus, refreshSkills, settingsDraft, settingsTouched, ua]);

  const deleteSkillFromSettings = useCallback(
    async (skill) => {
      if (!ua || !skill) return;
      const id = `${skill.domain}/${skill.filename}`;
      setDeletingSkillId(id);
      try {
        await ua.deleteSkill(skill.domain, skill.filename);
        appendStatus('status', `Deleted skill ${skill.name}.`);
        await refreshSkills();
      } catch (error) {
        appendStatus('error', `Delete skill failed: ${error.message}`);
      } finally {
        setDeletingSkillId('');
      }
    },
    [appendStatus, refreshSkills, ua]
  );

  const submitChat = useCallback(async () => {
    try {
      setProcessing(true);
      await processText(chatInput);
      setChatInput('');
    } catch (error) {
      appendStatus('error', `Text command failed: ${error.message}`);
    } finally {
      setProcessing(false);
    }
  }, [appendStatus, chatInput, processText]);

  const modeIndicator = useMemo(
    () =>
      mode === MODES.DEMO
        ? demoStage === DEMO_STAGE.CAPTURE
          ? isDemoRecording
            ? 'Demo Capture: recording continuously with VAD segmenting'
            : 'Demo Capture: click to start recording'
          : demoAwaitingConfirmation
            ? 'Demo Review: ready to create skill or apply corrections'
            : 'Demo Review: answer clarifying questions'
        : executionRunning
          ? 'Work Mode: task running (say stop/pause to interrupt)'
          : 'Work Mode: hold to speak command',
    [mode, demoStage, demoAwaitingConfirmation, executionRunning, isDemoRecording]
  );

  const debugMode = Boolean(settings.debugMode);
  const chatFeed = statusItems.filter((item) => item.type === 'agent');
  const showComposer = debugMode || chatComposerOpen;

  return (
    <main className="app-shell">
      <div className="app-bg-orb orb-a" />
      <div className="app-bg-orb orb-b" />

      <section className="app-surface">
        <div className="window-top-pad drag-region" aria-hidden="true" />
        <header className="app-header drag-region">
          <div>
            <h1>Universal Agent</h1>
            <p>{modeIndicator}</p>
          </div>
          <div className="header-controls no-drag">
            <div className="glass-pill mode-pill" role="tablist" aria-label="Mode">
              <button
                type="button"
                className={mode === MODES.WORK ? 'active' : ''}
                onClick={() => setMode(MODES.WORK)}
              >
                Work
              </button>
              <button
                type="button"
                className={mode === MODES.DEMO ? 'active' : ''}
                onClick={() => setMode(MODES.DEMO)}
              >
                Demo
              </button>
            </div>
            <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 8.75A3.25 3.25 0 1 0 12 15.25 3.25 3.25 0 0 0 12 8.75zm9 3.25-.87-.5.08-1a1.1 1.1 0 0 0-.79-1.1l-1-.27-.4-.94a1.1 1.1 0 0 0-1.02-.66h-1.01l-.66-.8a1.1 1.1 0 0 0-1.24-.34l-.97.35-.97-.35a1.1 1.1 0 0 0-1.24.34l-.66.8H7a1.1 1.1 0 0 0-1.02.66l-.4.94-1 .27a1.1 1.1 0 0 0-.79 1.1l.08 1-.87.5a1.1 1.1 0 0 0-.43 1.46l.5.87-.5.87a1.1 1.1 0 0 0 .43 1.46l.87.5-.08 1a1.1 1.1 0 0 0 .79 1.1l1 .27.4.94A1.1 1.1 0 0 0 7 20.5h1.01l.66.8a1.1 1.1 0 0 0 1.24.34l.97-.35.97.35a1.1 1.1 0 0 0 1.24-.34l.66-.8H17a1.1 1.1 0 0 0 1.02-.66l.4-.94 1-.27a1.1 1.1 0 0 0 .79-1.1l-.08-1 .87-.5a1.1 1.1 0 0 0 .43-1.46l-.5-.87.5-.87A1.1 1.1 0 0 0 21 12z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </header>

        <div className="controls-wrap">
          {mode === MODES.DEMO ? (
            <div className="stack">
              {demoStage === DEMO_STAGE.CAPTURE ? (
                <>
                  <button
                    type="button"
                    disabled={processing || demoReviewBusy}
                    onClick={() => {
                      appendStatus(
                        'status',
                        isDemoRecording
                          ? 'Demo narrate button clicked: stopping recording.'
                          : 'Demo narrate button clicked: starting recording.'
                      );
                      if (isDemoRecording) {
                        setDemoCanFinalize(true);
                      } else {
                        setDemoCanFinalize(false);
                      }
                      toggleDemoRecording();
                    }}
                    className={`glass-btn ${isDemoRecording ? 'danger' : 'primary'} ${
                      processing || demoReviewBusy ? 'disabled' : ''
                    }`}
                  >
                    {isDemoRecording ? 'Stop Recording' : 'Start Recording'}
                  </button>
                  {demoCanFinalize ? (
                    <button
                      type="button"
                      disabled={processing || demoReviewBusy || isDemoRecording}
                      onClick={finalizeDemoCapture}
                      className={`glass-btn muted ${
                        processing || demoReviewBusy || isDemoRecording ? 'disabled' : ''
                      }`}
                    >
                      End Demo & Review
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={processing || demoReviewBusy}
                    onMouseDown={startDemoReply}
                    onMouseUp={stopDemoReply}
                    onMouseLeave={isDemoReplyListening ? stopDemoReply : undefined}
                    onTouchStart={(event) => {
                      event.preventDefault();
                      startDemoReply();
                    }}
                    onTouchEnd={(event) => {
                      event.preventDefault();
                      stopDemoReply();
                    }}
                    className={`glass-btn ${isDemoReplyListening ? 'danger' : 'primary'} ${
                      processing || demoReviewBusy ? 'disabled' : ''
                    }`}
                  >
                    {isDemoReplyListening ? 'Listening...' : 'Hold to Reply'}
                  </button>
                  <button
                    type="button"
                    disabled={processing || demoReviewBusy || !demoAwaitingConfirmation}
                    onClick={createSkillFromReview}
                    className={`glass-btn success ${
                      processing || demoReviewBusy || !demoAwaitingConfirmation ? 'disabled' : ''
                    }`}
                  >
                    Create Skill
                  </button>
                  <button
                    type="button"
                    disabled={processing || demoReviewBusy}
                    onClick={() => {
                      setDemoStage(DEMO_STAGE.CAPTURE);
                      setDemoCanFinalize(false);
                      appendStatus('status', 'Returned to demo capture mode.');
                    }}
                    className={`glass-btn muted ${processing || demoReviewBusy ? 'disabled' : ''}`}
                  >
                    Resume Capture
                  </button>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={processing}
              onMouseDown={() => {
                appendStatus('status', 'Work speak button pressed: recording started.');
                startListening();
              }}
              onMouseUp={() => {
                appendStatus('status', 'Work speak button released: recording stopped.');
                stopListening();
              }}
              onMouseLeave={
                isListening
                  ? () => {
                      stopListening();
                    }
                  : undefined
              }
              onTouchStart={(event) => {
                event.preventDefault();
                appendStatus('status', 'Work speak button touched: recording started.');
                startListening();
              }}
              onTouchEnd={(event) => {
                event.preventDefault();
                appendStatus('status', 'Work speak touch ended: recording stopped.');
                stopListening();
              }}
              className={`glass-btn ${isListening ? 'danger' : 'primary'} ${processing ? 'disabled' : ''}`}
            >
              {isListening ? 'Listening...' : 'Hold to Speak'}
            </button>
          )}
        </div>

        <section
          className="glass-inset chat-panel"
          onClick={() => setChatComposerOpen(true)}
          onFocus={() => setChatComposerOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setChatComposerOpen(true);
          }}
        >
          <div className="chat-log">
            {chatFeed.length === 0 ? <p className="muted-text">Agent responses will appear here.</p> : null}
            {chatFeed.map((item) => (
              <article key={item.id} className="chat-bubble">
                <p>{item.message}</p>
              </article>
            ))}
          </div>
          {showComposer ? (
            <div className="chat-composer" onClick={(event) => event.stopPropagation()}>
              <input
                className="glass-input"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder={mode === MODES.WORK ? 'Type a task...' : 'Switch to Work mode for text commands'}
                disabled={processing || mode !== MODES.WORK}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitChat();
                  }
                }}
              />
              <button
                type="button"
                className="glass-btn small primary"
                onClick={submitChat}
                disabled={processing || mode !== MODES.WORK || !chatInput.trim()}
              >
                Send
              </button>
            </div>
          ) : (
            <p className="hint-text">Click to type</p>
          )}
        </section>

        {debugMode ? (
          <div className="debug-grid">
            <StatusFeed items={statusItems} />
            <SkillLog skills={skills.slice(-8).reverse()} />
          </div>
        ) : null}
      </section>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsError('');
          setSettingsDraft(settingsToDraft(settings));
          setSettingsTouched({});
        }}
        settings={settings}
        skills={skills.slice().reverse()}
        draft={settingsDraft}
        onDraftChange={(field, value) => {
          setSettingsDraft((prev) => ({ ...prev, [field]: value }));
          setSettingsTouched((prev) => ({ ...prev, [field]: true }));
        }}
        onSave={saveSettings}
        saving={settingsSaving}
        saveError={settingsError}
        onDeleteSkill={deleteSkillFromSettings}
        deletingSkillId={deletingSkillId}
      />
    </main>
  );
}
