import type {AgentAction} from './protocol.js';

export type CapabilityId =
  | 'read_screen'
  | 'tap_screen'
  | 'type_text'
  | 'focus_element'
  | 'click_element'
  | 'open_app'
  | 'resolve_app'
  | 'read_notifications'
  | 'read_calls'
  | 'read_sms'
  | 'send_sms'
  | 'make_call'
  | 'end_call'
  | 'show_overlay'
  | 'run_background'
  | 'run_local_model';

export interface CapabilityRequirement {
  id: CapabilityId;
  androidPermission?: string;
  androidSetting?: string;
  userFacingName: string;
}

export interface CapabilityCheck {
  available: boolean;
  required: CapabilityRequirement[];
  reason?: string;
}

const ACTION_CAPABILITIES: Partial<Record<AgentAction['action'], CapabilityId[]>> = {
  tap: ['tap_screen'],
  type: ['type_text'],
  type_text: ['type_text'],
  find_and_tap: ['read_screen', 'tap_screen'],
  swipe: ['tap_screen'],
  open_app: ['open_app'],
  resolve_app: ['resolve_app'],
  list_apps: ['open_app'],
  get_device_profile: [],
  get_recent_calls: ['read_calls'],
  get_recent_sms: ['read_sms'],
  compose_message: ['read_sms'],
  send_sms: ['send_sms'],
  call: ['make_call'],
  end_call: ['end_call'],
  wait: [],
  task_complete: [],
  task_failed: [],
  find_element: ['read_screen'],
  find_and_click: ['read_screen', 'click_element'],
  focus_element: ['focus_element'],
  click_element: ['click_element'],
  press_key: ['type_text'],
  press_back: ['tap_screen'],
  resolve_chooser: ['read_screen', 'click_element'],
  open_url: ['open_app'],
};

const REQUIREMENTS: Record<CapabilityId, CapabilityRequirement> = {
  read_screen: {
    id: 'read_screen',
    androidSetting: 'Accessibility Service',
    userFacingName: 'Accessibility screen reading',
  },
  tap_screen: {
    id: 'tap_screen',
    androidSetting: 'Accessibility Service',
    userFacingName: 'Accessibility touch control',
  },
  type_text: {
    id: 'type_text',
    androidSetting: 'Accessibility Service',
    userFacingName: 'Accessibility typing',
  },
  focus_element: {
    id: 'focus_element',
    androidSetting: 'Accessibility Service',
    userFacingName: 'Accessibility focus control',
  },
  click_element: {
    id: 'click_element',
    androidSetting: 'Accessibility Service',
    userFacingName: 'Accessibility click control',
  },
  open_app: {
    id: 'open_app',
    userFacingName: 'Open installed apps',
  },
  resolve_app: {
    id: 'resolve_app',
    userFacingName: 'Resolve installed app names',
  },
  read_notifications: {
    id: 'read_notifications',
    androidSetting: 'Notification Access',
    userFacingName: 'Notification access',
  },
  read_calls: {
    id: 'read_calls',
    androidPermission: 'READ_CALL_LOG',
    userFacingName: 'Call log access',
  },
  read_sms: {
    id: 'read_sms',
    androidPermission: 'READ_SMS',
    userFacingName: 'SMS access',
  },
  send_sms: {
    id: 'send_sms',
    androidPermission: 'SEND_SMS',
    userFacingName: 'Send SMS',
  },
  make_call: {
    id: 'make_call',
    androidPermission: 'CALL_PHONE',
    userFacingName: 'Phone calling',
  },
  end_call: {
    id: 'end_call',
    androidPermission: 'ANSWER_PHONE_CALLS',
    userFacingName: 'End phone calls',
  },
  show_overlay: {
    id: 'show_overlay',
    androidSetting: 'Display over other apps',
    userFacingName: 'Floating overlay',
  },
  run_background: {
    id: 'run_background',
    androidSetting: 'Unrestricted battery usage',
    userFacingName: 'Background operation',
  },
  run_local_model: {
    id: 'run_local_model',
    userFacingName: 'Local AI runtime',
  },
};

export class CapabilityManager {
  private readonly available = new Map<CapabilityId, boolean>();

  constructor() {
    for (const id of Object.keys(REQUIREMENTS) as CapabilityId[]) {
      this.available.set(id, true);
    }
  }

  setCapability(id: CapabilityId, available: boolean): void {
    this.available.set(id, available);
  }

  checkAction(action: AgentAction): CapabilityCheck {
    const ids = ACTION_CAPABILITIES[action.action] ?? [];
    const missing = ids
      .filter(id => this.available.get(id) === false)
      .map(id => REQUIREMENTS[id]);

    return {
      available: missing.length === 0,
      required: missing,
      reason: missing.length > 0 ? `Missing capability: ${missing.map(item => item.userFacingName).join(', ')}` : undefined,
    };
  }
}
