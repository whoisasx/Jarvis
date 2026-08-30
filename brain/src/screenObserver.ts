import type {ScreenState} from './protocol.js';

export interface ScreenElement {
  elementId: string;
  label: string;
  text: string;
  hint?: string;
  className: string;
  packageName: string;
  resourceId: string;
  contentDescription: string;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  editable: boolean;
  enabled: boolean;
  visible: boolean;
  bounds: [number, number, number, number];
  supportedActions: string[];
}

export interface ScreenModel {
  packageName: string;
  title: string;
  buttons: ScreenElement[];
  textFields: ScreenElement[];
  text: string[];
  lists: ScreenElement[];
  dialogs: ScreenElement[];
  scrollable: boolean;
  clickableCount: number;
  editableCount: number;
  nodeCount: number;
  summary: string;
}

interface NodeSchema {
  elementId?: string;
  text: string;
  contentDescription: string;
  className: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  editable: boolean;
  packageName: string;
  resourceId: string;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
}

export class ScreenObserver {
  observe(screen: ScreenState): ScreenModel {
    const textNodes = screen.nodeTree
      .map((node: NodeSchema) => {
        const className = node.className || '';
        const supportedActions: string[] = [];

        // Preserve elementId from Android side if available, otherwise generate one
        const elementId = node.elementId || `element_${Math.random().toString(36).substring(2, 10)}`;

        if (/EditText|TextInput/i.test(className)) {
          supportedActions.push('focus', 'set_text');
        } else if (/Button|ImageButton/i.test(className)) {
          supportedActions.push('click');
        } else if (/ScrollView|RecyclerView|ListView|ViewPager/i.test(className)) {
          supportedActions.push('scroll_forward', 'scroll_backward');
        }

        if (node.focusable) {
          supportedActions.push('focus');
        }

        const boundsTuple = node.bounds;
        const hasVisibleBounds = boundsTuple != null && boundsTuple[0] >= 0 && boundsTuple[2] > boundsTuple[0] && boundsTuple[1] >= 0 && boundsTuple[3] > boundsTuple[1];

        return {
          elementId,
          label: cleanLabel(node.text || node.contentDescription || ''),
          text: node.text || '',
          className,
          packageName: node.packageName || screen.packageName,
          resourceId: node.resourceId || '',
          contentDescription: node.contentDescription || '',
          focusable: node.focusable ?? false,
          focused: node.focused ?? false,
          enabled: node.enabled ?? true,
          clickable: node.clickable,
          editable: node.editable,
          visible: hasVisibleBounds,
          bounds: boundsTuple || [0, 0, 0, 0],
          supportedActions,
        };
      })
      .filter(node => node.label);

    const buttons = textNodes
      .filter(node => node.clickable || looksLikeButton(node.className))
      .map(toElement)
      .slice(0, 40);

    const textFields = textNodes
      .filter(node => node.editable || looksLikeTextField(node.className))
      .map(toElement)
      .slice(0, 20);

    const lists = textNodes
      .filter(node => looksLikeList(node.className))
      .map(toElement)
      .slice(0, 10);

    const dialogs = textNodes
      .filter(node => looksLikeDialog(node.className))
      .map(toElement)
      .slice(0, 10);

    const visibleText = [...new Set(textNodes.map(node => node.label))]
      .filter(label => label.length <= 120)
      .slice(0, 80);

    const title = inferTitle(visibleText, screen.packageName);
    const scrollable = screen.nodeTree.some((node: NodeSchema) => /ScrollView|RecyclerView|ListView|ViewPager/i.test(node.className));
    const clickableCount = screen.nodeTree.filter((node: NodeSchema) => node.clickable).length;
    const editableCount = screen.nodeTree.filter((node: NodeSchema) => node.editable).length;

    return {
      packageName: screen.packageName,
      title,
      buttons,
      textFields,
      text: visibleText,
      lists,
      dialogs,
      scrollable,
      clickableCount,
      editableCount,
      nodeCount: screen.nodeTree.length,
      summary: summarizeScreen(title, buttons, textFields, visibleText, scrollable),
    };
  }
}

function toElement(node: {
  elementId: string;
  label: string;
  text: string;
  className: string;
  packageName: string;
  resourceId: string;
  contentDescription: string;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  editable: boolean;
  enabled: boolean;
  visible: boolean;
  bounds: [number, number, number, number];
  supportedActions: string[];
}): ScreenElement {
  return {
    elementId: node.elementId,
    label: node.label,
    text: node.text,
    className: shortClassName(node.className),
    packageName: node.packageName,
    resourceId: node.resourceId,
    contentDescription: node.contentDescription,
    clickable: node.clickable,
    focusable: node.focusable,
    focused: node.focused,
    editable: node.editable,
    enabled: node.enabled,
    visible: node.visible,
    bounds: node.bounds,
    supportedActions: node.supportedActions,
  };
}

function inferTitle(text: string[], packageName: string): string {
  const meaningful = text.find(label =>
    label.length >= 3 &&
    label.length <= 48 &&
    !/^(back|search|more options|close|done|cancel|ok)$/i.test(label),
  );
  return meaningful || packageName || 'Unknown screen';
}

function summarizeScreen(
  title: string,
  buttons: ScreenElement[],
  textFields: ScreenElement[],
  text: string[],
  scrollable: boolean,
): string {
  const parts = [`title=${title}`];
  if (buttons.length) parts.push(`buttons=${buttons.slice(0, 8).map(button => button.label).join(', ')}`);
  if (textFields.length) parts.push(`fields=${textFields.slice(0, 5).map(field => field.label).join(', ')}`);
  if (!buttons.length && !textFields.length && text.length) parts.push(`text=${text.slice(0, 8).join(', ')}`);
  if (scrollable) parts.push('scrollable=true');
  return parts.join(' | ');
}

function cleanLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function looksLikeButton(className: string): boolean {
  return /Button|ImageButton|CheckedTextView|Switch|CheckBox|RadioButton/i.test(className);
}

function looksLikeTextField(className: string): boolean {
  return /EditText|TextInput/i.test(className);
}

function looksLikeList(className: string): boolean {
  return /RecyclerView|ListView|GridView/i.test(className);
}

function looksLikeDialog(className: string): boolean {
  return /Dialog|Popup|BottomSheet/i.test(className);
}

function shortClassName(value: string): string {
  const parts = value.split('.');
  return parts[parts.length - 1] || value;
}
