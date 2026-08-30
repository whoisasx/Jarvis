import type {ScreenModel} from './screenObserver.js';
import type {ScreenState} from './protocol.js';
import type {WorldStateSnapshot} from './worldState.js';
import type {ToolObservation} from './toolTypes.js';

export interface ElementMetadata {
  id: string;
  elementId?: string;
  label: string;
  className: string;
  resourceId: string;
  contentDescription: string;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  bounds: [number, number, number, number];
  packageName: string;
}

export function compactObservation(input: {
  screen?: ScreenState;
  model?: ScreenModel | null;
  world?: WorldStateSnapshot;
  lastActionResult?: string | null;
}): ToolObservation {
  const model = input.model ?? input.world?.screen ?? null;
  const labels = [
    ...(model?.buttons ?? []).map(item => item.label),
    ...(model?.textFields ?? []).map(item => item.label),
    ...(model?.text ?? []),
  ]
    .map(label => label.trim())
    .filter(Boolean);

  const visibleElements = [...new Set(labels)].slice(0, 16).map(label => {
    const elementNodes = (model?.buttons ?? [])
      .concat(model?.textFields ?? [])
      .concat(model?.lists ?? [])
      .concat(model?.dialogs ?? [])
      .filter(item => item.label === label);
    const node = elementNodes[0];
    return {
      id: node?.elementId || '',
      elementId: node?.elementId || '',
      label: node?.label || label,
      className: node?.className || '',
      resourceId: node?.resourceId || '',
      contentDescription: node?.contentDescription || '',
      focusable: node?.focusable ?? false,
      focused: node?.focused ?? false,
      enabled: node?.enabled ?? true,
      bounds: node?.bounds ?? [0, 0, 0, 0],
      packageName: node?.packageName || '',
    } as ElementMetadata;
  });

  return {
    currentApp: model?.packageName || input.world?.currentApp || input.screen?.packageName || '',
    currentAppLabel: input.world?.currentAppLabel || undefined,
    screen: model?.title || input.world?.screen?.title || input.world?.currentApp || 'unknown',
    summary: model?.summary || input.world?.screen?.summary || 'No screen summary yet',
    visibleElements,
    clickableCount: model?.clickableCount,
    editableCount: model?.editableCount,
    scrollable: model?.scrollable,
    lastActionResult: input.lastActionResult ?? input.screen?.lastActionResult ?? null,
    screenLocked: input.world?.screenLocked,
    batteryPercent: input.world?.batteryPercent ?? null,
    nodeCount: input.screen?.nodeCount ?? input.screen?.nodeTree?.length ?? model?.nodeCount,
    treeAvailable: input.screen?.treeAvailable ?? ((input.screen?.nodeTree?.length ?? model?.nodeCount ?? 0) > 0),
    observationReason: input.screen?.observationReason ?? ((input.screen?.nodeTree?.length ?? 0) === 0 ? 'EMPTY_TREE' : null),
    observationFresh: input.screen?.observationFresh,
  };
}
