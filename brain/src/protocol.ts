import {z} from 'zod';
import {JARVIS_EVENT_TYPES, type JarvisEventPriority} from './eventBus.js';

const nodeSchema = z.object({
  elementId: z.string().optional().default(''),
  text: z.string().optional().default(''),
  contentDescription: z.string().optional().default(''),
  className: z.string().optional().default(''),
  bounds: z.array(z.number()).min(4).transform(value => [value[0], value[1], value[2], value[3]] as [number, number, number, number]),
  clickable: z.boolean().optional().default(false),
  editable: z.boolean().optional().default(false),
  packageName: z.string().optional().default(''),
  resourceId: z.string().optional().default(''),
  focusable: z.boolean().optional().default(false),
  focused: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
});

export const phoneMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('screen_state'),
    nodeTree: z.array(nodeSchema),
    screenshotBase64: z.string().optional(),
    screenshotMediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    packageName: z.string().default(''),
    nodeCount: z.number().optional(),
    treeAvailable: z.boolean().optional(),
    observationReason: z.string().nullable().optional(),
    lastActionResult: z.string().nullable().optional(),
    requestId: z.string().optional(),
    observationFresh: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('notification'),
    packageName: z.string(),
    title: z.string(),
    text: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('sms_received'),
    sender: z.string(),
    body: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('android_event'),
    eventType: z.enum(JARVIS_EVENT_TYPES),
    source: z.string(),
    priority: z.enum(['low', 'normal', 'high', 'critical']).transform(value => value as JarvisEventPriority),
    timestamp: z.number(),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('device_observation'),
    kind: z.enum(['app_changed', 'screen_changed', 'screen_activity', 'user_interaction']),
    packageName: z.string(),
    appLabel: z.string().optional().default(''),
    className: z.string().optional().default(''),
    eventType: z.string().optional().default(''),
    timestamp: z.number(),
  }),
]);

const progressFields = {
  status: z.string().max(160).optional(),
  progress: z.number().int().min(0).max(100).optional(),
};
const tap = z.object({action: z.literal('tap'), x: z.number(), y: z.number(), ...progressFields});
const type = z.object({action: z.literal('type'), text: z.string(), elementId: z.string().optional(), ...progressFields});
const typeText = z.object({action: z.literal('type_text'), text: z.string(), elementId: z.string().optional(), ...progressFields});
const findAndTap = z.object({action: z.literal('find_and_tap'), targetText: z.string(), ...progressFields});
const findElement = z.object({action: z.literal('find_element'), text: z.string().optional(), contentDescription: z.string().optional(), resourceId: z.string().optional(), className: z.string().optional(), editable: z.boolean().optional(), clickable: z.boolean().optional(), ...progressFields});
const findAndClick = z.object({action: z.literal('find_and_click'), text: z.string().optional(), contentDescription: z.string().optional(), resourceId: z.string().optional(), className: z.string().optional(), editable: z.boolean().optional(), clickable: z.boolean().optional(), ...progressFields});
const focusElement = z.object({action: z.literal('focus_element'), elementId: z.string(), ...progressFields});
const clickElement = z.object({action: z.literal('click_element'), elementId: z.string(), ...progressFields});
const pressKey = z.object({action: z.literal('press_key'), key: z.string(), ...progressFields});
const pressBack = z.object({action: z.literal('press_back'), ...progressFields});
const endCall = z.object({action: z.literal('end_call'), ...progressFields});
const getRecentSms = z.object({action: z.literal('get_recent_sms'), limit: z.number().int().min(1).max(50), ...progressFields});
const composeMessage = z.object({action: z.literal('compose_message'), number: z.string(), body: z.string().optional(), packageName: z.string().optional(), ...progressFields});
const sendSms = z.object({action: z.literal('send_sms'), number: z.string(), body: z.string(), ...progressFields});
const resolveChooser = z.object({
  action: z.literal('resolve_chooser'),
  preferredPackage: z.string().optional(),
  preferredLabel: z.string().optional(),
  ...progressFields,
});
const openUrl = z.object({action: z.literal('open_url'), url: z.string(), ...progressFields});
const swipe = z.object({
  action: z.literal('swipe'),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  ...progressFields,
});
const openApp = z.object({action: z.literal('open_app'), packageName: z.string(), ...progressFields});
const resolveApp = z.object({action: z.literal('resolve_app'), appName: z.string(), ...progressFields});
const listApps = z.object({action: z.literal('list_apps'), ...progressFields});
const getDeviceProfile = z.object({action: z.literal('get_device_profile'), ...progressFields});
const call = z.object({action: z.literal('call'), number: z.string(), ...progressFields});
const getRecentCalls = z.object({action: z.literal('get_recent_calls'), limit: z.number().int().min(1).max(50), ...progressFields});
const wait = z.object({action: z.literal('wait'), ms: z.number().int().min(0).max(30_000), ...progressFields});
const taskComplete = z.object({action: z.literal('task_complete'), summary: z.string(), ...progressFields});
const taskFailed = z.object({action: z.literal('task_failed'), reason: z.string(), ...progressFields});

export const agentActionSchema = z.discriminatedUnion('action', [
  tap,
  type,
  typeText,
  findAndTap,
  findElement,
  findAndClick,
  focusElement,
  clickElement,
  pressKey,
  pressBack,
  endCall,
  getRecentSms,
  composeMessage,
  sendSms,
  resolveChooser,
  openUrl,
  swipe,
  openApp,
  resolveApp,
  listApps,
  getDeviceProfile,
  call,
  getRecentCalls,
  wait,
  taskComplete,
  taskFailed,
]);

export type PhoneMessage = z.infer<typeof phoneMessageSchema>;
export type ScreenState = Extract<PhoneMessage, {type: 'screen_state'}>;
export type AgentAction = z.infer<typeof agentActionSchema>;

export type BrainMessage =
  | ({type: 'action'; requestId?: string} & AgentAction)
  | {type: 'request_screen_state'; requestId?: string}
  | {type: 'task_status'; status: string; detail?: string};
