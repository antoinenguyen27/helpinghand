const IPC_CHANNELS = {
  VOICE_PROCESS: 'voice:process',
  DEMO_START: 'demo:start',
  DEMO_END: 'demo:end',
  DEMO_FINALIZE: 'demo:finalize',
  DEMO_SAVE: 'demo:save',
  WORK_STOP: 'work:stop',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SKILLS_LIST: 'skills:list',
  EXEC_INTERRUPT: 'exec:interrupt',
  STATUS_UPDATE: 'status:update',
  EXEC_STATE: 'exec:state'
};

module.exports = { IPC_CHANNELS };
