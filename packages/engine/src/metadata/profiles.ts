import { extractChildBlocks } from '../snapshot/indexer.js';

/**
 * PermissionSet XML → a grouped, human-readable permissions view. The raw
 * XML is noise to a consultant scanning "what does this grant?" — this is
 * the browser's parsed tab (and later, prompt material for the agent).
 * Same block-parsing idiom as the indexer; no XML library.
 */

export interface ObjectPermissionView {
  object: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export interface FieldPermissionView {
  field: string;
  readable: boolean;
  editable: boolean;
}

export interface ToggleView {
  name: string;
  enabled: boolean;
}

export interface TabSettingView {
  tab: string;
  visibility: string;
}

export interface PermissionSetView {
  label: string | null;
  license: string | null;
  description: string | null;
  objectPermissions: ObjectPermissionView[];
  fieldPermissions: FieldPermissionView[];
  userPermissions: ToggleView[];
  classAccesses: ToggleView[];
  pageAccesses: ToggleView[];
  tabSettings: TabSettingView[];
  recordTypeVisibilities: ToggleView[];
  applicationVisibilities: ToggleView[];
}

function tagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

function tagBool(block: string, tag: string): boolean {
  return tagValue(block, tag) === 'true';
}

export function parsePermissionSet(xml: string): PermissionSetView {
  const view: PermissionSetView = {
    label: tagValue(xml, 'label'),
    license: tagValue(xml, 'license'),
    description: tagValue(xml, 'description'),
    objectPermissions: [],
    fieldPermissions: [],
    userPermissions: [],
    classAccesses: [],
    pageAccesses: [],
    tabSettings: [],
    recordTypeVisibilities: [],
    applicationVisibilities: [],
  };

  for (const block of extractChildBlocks(xml, 'objectPermissions')) {
    const object = tagValue(block, 'object');
    if (!object) continue;
    view.objectPermissions.push({
      object,
      read: tagBool(block, 'allowRead'),
      create: tagBool(block, 'allowCreate'),
      edit: tagBool(block, 'allowEdit'),
      delete: tagBool(block, 'allowDelete'),
      viewAll: tagBool(block, 'viewAllRecords'),
      modifyAll: tagBool(block, 'modifyAllRecords'),
    });
  }
  for (const block of extractChildBlocks(xml, 'fieldPermissions')) {
    const field = tagValue(block, 'field');
    if (!field) continue;
    view.fieldPermissions.push({
      field,
      readable: tagBool(block, 'readable'),
      editable: tagBool(block, 'editable'),
    });
  }
  const toggles: Array<[keyof PermissionSetView, string, string, string]> = [
    ['userPermissions', 'userPermissions', 'name', 'enabled'],
    ['classAccesses', 'classAccesses', 'apexClass', 'enabled'],
    ['pageAccesses', 'pageAccesses', 'apexPage', 'enabled'],
    ['recordTypeVisibilities', 'recordTypeVisibilities', 'recordType', 'visible'],
    ['applicationVisibilities', 'applicationVisibilities', 'application', 'visible'],
  ];
  for (const [key, tag, nameTag, enabledTag] of toggles) {
    for (const block of extractChildBlocks(xml, tag)) {
      const name = tagValue(block, nameTag);
      if (!name) continue;
      (view[key] as ToggleView[]).push({ name, enabled: tagBool(block, enabledTag) });
    }
  }
  for (const block of extractChildBlocks(xml, 'tabSettings')) {
    const tab = tagValue(block, 'tab');
    if (!tab) continue;
    view.tabSettings.push({ tab, visibility: tagValue(block, 'visibility') ?? 'None' });
  }

  return view;
}
