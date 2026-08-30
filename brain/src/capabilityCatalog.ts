import type {AgentAction} from './protocol.js';
import type {CapabilityId} from './capabilityManager.js';
import type {ScreenElement} from './screenObserver.js';

export interface CapabilityDescriptor {
  name: string;
  description: string;
  capabilityIds: CapabilityId[];
  sensitive: boolean;
  kind: 'device' | 'memory' | 'state';
  inputSchema: Record<string, unknown>;
  toAction?: (args: Record<string, unknown>) => AgentAction;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

export const CAPABILITY_CATALOG: CapabilityDescriptor[] = [
  {
    name: 'open_app',
    description: 'Open an installed Android app by package name. Prefer resolve_app first when the user gave a display name.',
    capabilityIds: ['open_app'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['packageName'],
      properties: {packageName: {type: 'string', description: 'Android package name'}},
    },
    toAction: args => ({action: 'open_app', packageName: stringArg(args, 'packageName')}),
  },
  {
    name: 'resolve_app',
    description: 'Resolve a user-facing app name to an installed package name.',
    capabilityIds: ['resolve_app'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['appName'],
      properties: {appName: {type: 'string'}},
    },
    toAction: args => ({action: 'resolve_app', appName: stringArg(args, 'appName')}),
  },
  {
    name: 'list_apps',
    description: 'List launchable apps installed on the device.',
    capabilityIds: ['open_app'],
    sensitive: false,
    kind: 'device',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
    toAction: () => ({action: 'list_apps'}),
  },
  {
    name: 'tap',
    description: 'FALLBACK ONLY. Tap screen coordinates in pixels. Prefer find_element + click_element for normal UI interaction. Use only when no accessibility element can be identified.',
    capabilityIds: ['tap_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {x: {type: 'number'}, y: {type: 'number'}},
    },
    toAction: args => ({action: 'tap', x: numberArg(args, 'x'), y: numberArg(args, 'y')}),
  },
  {
    name: 'find_and_tap',
    description: 'FALLBACK ONLY. Find a visible UI element by text or content description and tap it. Prefer find_element + click_element for semantic interaction.',
    capabilityIds: ['read_screen', 'tap_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['targetText'],
      properties: {targetText: {type: 'string'}},
    },
    toAction: args => ({action: 'find_and_tap', targetText: stringArg(args, 'targetText')}),
  },
  {
    name: 'type_text',
    description: 'Type into an editable field. Prefer passing elementId from find_element. If omitted, uses the focused editable field, then the first visible editable field. Focuses/clicks the target before typing. Never uses coordinates.',
    capabilityIds: ['type_text'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {text: {type: 'string'}, elementId: {type: 'string', description: 'Stable identifier from find_element or read_screen'}},
    },
    toAction: args => ({action: 'type_text', text: stringArg(args, 'text'), elementId: args['elementId'] as string | undefined}),
  },
  {
    name: 'find_element',
    description: 'Find a UI element by text, content description, resource ID, or class name. Returns element metadata including bounds and stable elementId. PREFERRED over coordinate-based interaction. Use this to locate elements before focus_element, click_element, or type_text.',
    capabilityIds: ['read_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {type: 'string', description: 'Text label to match'},
        contentDescription: {type: 'string', description: 'Content description to match'},
        resourceId: {type: 'string', description: 'Resource ID to match'},
        className: {type: 'string', description: 'Class name to match'},
        editable: {type: 'boolean', description: 'Filter for editable fields'},
        clickable: {type: 'boolean', description: 'Filter for clickable elements'},
      },
    },
    toAction: args => ({action: 'find_element', ...args}),
  },
  {
    name: 'find_and_click',
    description: 'Atomically find a UI element and click it on-device. Prefer this over find_element + click_element to avoid ELEMENT_STALE races. Matches exact text/contentDescription first, then substring. Prefers non-editable content over input fields when both match. Fails with MATCH_AMBIGUOUS when multiple distinct content nodes match, or NO_VISIBLE_CHANGE when a click does not change the screen. Optional resourceId and className filters.',
    capabilityIds: ['read_screen', 'click_element'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {type: 'string'},
        contentDescription: {type: 'string'},
        resourceId: {type: 'string'},
        className: {type: 'string'},
        editable: {type: 'boolean'},
        clickable: {type: 'boolean'},
      },
    },
    toAction: args => ({action: 'find_and_click', ...args}),
  },
  {
    name: 'focus_element',
    description: 'Focus on an editable/focusable UI element by its stable elementId from find_element or read_screen. PREFERRED over coordinate taps for focusing inputs. Fails with ELEMENT_STALE if the element is no longer available, ELEMENT_NOT_FOUND if unknown, ELEMENT_DISABLED if disabled, NOT_FOCUSABLE if not focusable. Use elementId from find_element/read_screen. Never use coordinates to focus an element.',
    capabilityIds: ['focus_element'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['elementId'],
      properties: {elementId: {type: 'string', description: 'Stable identifier from find_element or read_screen'}},
    },
    toAction: args => ({action: 'focus_element', elementId: stringArg(args, 'elementId')}),
  },
  {
    name: 'click_element',
    description: 'Click on a clickable UI element by its stable elementId from find_element or read_screen. PREFERRED over coordinate taps (jarvis_tap) for normal UI interaction. Fails with ELEMENT_STALE if the element is no longer available, ELEMENT_NOT_FOUND if unknown, NOT_CLICKABLE if not clickable.',
    capabilityIds: ['click_element'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['elementId'],
      properties: {elementId: {type: 'string', description: 'Stable identifier from find_element or read_screen'}},
    },
    toAction: args => ({action: 'click_element', elementId: stringArg(args, 'elementId')}),
  },
  {
    name: 'press_key',
    description: 'Dispatch a key. Supported: enter, back, home. For navigation prefer press_back. Reports failure if the key was not actually sent.',
    capabilityIds: ['type_text'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {key: {type: 'string', description: 'enter | back | home'}},
    },
    toAction: args => ({action: 'press_key', key: stringArg(args, 'key')}),
  },
  {
    name: 'press_back',
    description: 'Perform Android back. Result reports keyboardWasVisible, keyboardDismissed, screenChanged, and navigated. Keyboard dismiss is not navigation. Same-package screen changes set navigated and screenChanged. No package change is required.',
    capabilityIds: ['tap_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
    toAction: () => ({action: 'press_back'}),
  },
  {
    name: 'resolve_chooser',
    description: 'Handle an Android intent chooser (Just once / Always / app list). If preferredPackage or preferredLabel uniquely matches, selects it. If only Just once/Always remains, selects Just once. If multiple apps remain and no preference is given, fails with CHOOSER_AMBIGUOUS and lists options. Never silently picks an unintended app.',
    capabilityIds: ['read_screen', 'click_element'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        preferredPackage: {type: 'string'},
        preferredLabel: {type: 'string'},
      },
    },
    toAction: args => ({
      action: 'resolve_chooser',
      preferredPackage: typeof args.preferredPackage === 'string' ? args.preferredPackage : undefined,
      preferredLabel: typeof args.preferredLabel === 'string' ? args.preferredLabel : undefined,
    }),
  },
  {
    name: 'open_url',
    description: 'Open a URL in the Android browser (Chrome). Navigates directly without typing.',
    capabilityIds: ['open_app'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {url: {type: 'string', description: 'URL to open (e.g., https://google.com/search?q=system+design)'}},
    },
    toAction: args => ({action: 'open_url', url: stringArg(args, 'url')}),
  },
  {
    name: 'swipe',
    description: 'Swipe from (x1,y1) to (x2,y2).',
    capabilityIds: ['tap_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x1', 'y1', 'x2', 'y2'],
      properties: {x1: {type: 'number'}, y1: {type: 'number'}, x2: {type: 'number'}, y2: {type: 'number'}},
    },
    toAction: args => ({
      action: 'swipe',
      x1: numberArg(args, 'x1'),
      y1: numberArg(args, 'y1'),
      x2: numberArg(args, 'x2'),
      y2: numberArg(args, 'y2'),
    }),
  },
  {
    name: 'wait',
    description: 'Wait for the UI to settle, then return a fresh observation.',
    capabilityIds: [],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {ms: {type: 'number', minimum: 0, maximum: 30000}},
    },
    toAction: args => ({action: 'wait', ms: typeof args.ms === 'number' ? Math.max(0, Math.min(30_000, args.ms)) : 800}),
  },
  {
    name: 'read_screen',
    description: 'Capture the current semantic screen model without performing an input action.',
    capabilityIds: ['read_screen'],
    sensitive: false,
    kind: 'device',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
  },
  {
    name: 'get_device_profile',
    description: 'Read Android version, device model, RAM, CPU, storage, battery, and thermal info.',
    capabilityIds: [],
    sensitive: false,
    kind: 'device',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
    toAction: () => ({action: 'get_device_profile'}),
  },
  {
    name: 'get_recent_calls',
    description: 'Read recent call-log entries.',
    capabilityIds: ['read_calls'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {limit: {type: 'number', minimum: 1, maximum: 50}},
    },
    toAction: args => ({
      action: 'get_recent_calls',
      limit: typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.trunc(args.limit))) : 10,
    }),
  },
  {
    name: 'make_call',
    description: 'Place a phone call. Requires confirmSensitive=true because this leaves the device.',
    capabilityIds: ['make_call'],
    sensitive: true,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['number'],
      properties: {number: {type: 'string'}},
    },
    toAction: args => ({action: 'call', number: stringArg(args, 'number')}),
  },
  {
    name: 'end_call',
    description: 'End the active phone call. Preferred over tapping End call. Fails with NO_ACTIVE_CALL if nothing is in progress.',
    capabilityIds: ['end_call'],
    sensitive: false,
    kind: 'device',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
    toAction: () => ({action: 'end_call'}),
  },
  {
    name: 'read_sms',
    description: 'Read recent SMS inbox/outbox entries.',
    capabilityIds: ['read_sms'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {limit: {type: 'number', minimum: 1, maximum: 50}},
    },
    toAction: args => ({
      action: 'get_recent_sms',
      limit: typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.trunc(args.limit))) : 10,
    }),
  },
  {
    name: 'compose_message',
    description: 'Open a draft SMS in the selected messaging app. Never sends and never changes the default SMS app. Returns draftCreated plus recipient/body visibility. If the app cannot compose because it is not the default SMS app, fails with NOT_DEFAULT_SMS_APP. Optional packageName pins a specific composer.',
    capabilityIds: ['read_sms'],
    sensitive: false,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['number'],
      properties: {
        number: {type: 'string'},
        body: {type: 'string'},
        packageName: {type: 'string', description: 'Optional explicit messaging package'},
      },
    },
    toAction: args => ({
      action: 'compose_message',
      number: stringArg(args, 'number'),
      body: typeof args.body === 'string' ? args.body : undefined,
      packageName: typeof args.packageName === 'string' && args.packageName.trim() ? args.packageName : undefined,
    }),
  },
  {
    name: 'send_sms',
    description: 'Send an SMS immediately. Requires confirmSensitive=true. Use compose_message to draft without sending.',
    capabilityIds: ['send_sms'],
    sensitive: true,
    kind: 'device',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['number', 'body'],
      properties: {number: {type: 'string'}, body: {type: 'string'}},
    },
    toAction: args => ({action: 'send_sms', number: stringArg(args, 'number'), body: stringArg(args, 'body')}),
  },
  {
    name: 'get_notifications',
    description: 'Read the latest notification snapshot and recent notification events from device history.',
    capabilityIds: ['read_notifications'],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {limit: {type: 'number', minimum: 1, maximum: 50}},
    },
  },
  {
    name: 'get_world_state',
    description: 'Read the current Jarvis world-state snapshot.',
    capabilityIds: [],
    sensitive: false,
    kind: 'state',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
  },
  {
    name: 'get_recent_events',
    description: 'Read recent normalized device and brain events.',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {limit: {type: 'number', minimum: 1, maximum: 80}},
    },
  },
  {
    name: 'search_memory',
    description: 'Search event history, memory candidates, and durable learned procedures (RAG playbooks).',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {query: {type: 'string'}, limit: {type: 'number'}},
    },
  },
  {
    name: 'get_relevant_context',
    description: 'Build compact context for a goal from world state, working memory, recent events, and retrieved playbooks from past successful tasks. Call this first on a new goal so Jarvis can reuse what it already learned.',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal'],
      properties: {goal: {type: 'string'}},
    },
  },
  {
    name: 'get_similar_procedures',
    description: 'Retrieve the closest durable playbooks for a goal. Use before inventing a new UI path in an app Jarvis has used before.',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: {type: 'string'},
        limit: {type: 'number', minimum: 1, maximum: 8},
      },
    },
  },
  {
    name: 'remember_procedure',
    description: 'Save the current session tool sequence as a durable playbook so the next similar goal can reuse it. Call after a task works or after a useful failure with notes.',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {type: 'string'},
        outcome: {type: 'string', description: 'success or failed'},
        notes: {type: 'string'},
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark the current goal finished and persist the learned playbook. Prefer this when the user goal is done so Jarvis does not forget the path.',
    capabilityIds: [],
    sensitive: false,
    kind: 'memory',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {type: 'string'},
        outcome: {type: 'string', description: 'success or failed'},
        notes: {type: 'string'},
      },
    },
  },
];

export function findCapability(name: string): CapabilityDescriptor | undefined {
  return CAPABILITY_CATALOG.find(item => item.name === name);
}
