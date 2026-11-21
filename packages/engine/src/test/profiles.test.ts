import { describe, expect, it } from 'vitest';
import { parsePermissionSet } from '../metadata/profiles.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Sales Ops</label>
    <license>Salesforce</license>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Account</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Account.LF4_Region__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <userPermissions>
        <enabled>true</enabled>
        <name>ExecutePromptTemplates</name>
    </userPermissions>
    <classAccesses>
        <apexClass>InvoiceService</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <tabSettings>
        <tab>Account</tab>
        <visibility>Visible</visibility>
    </tabSettings>
</PermissionSet>`;

describe('parsePermissionSet', () => {
  it('parses grouped permissions from real-shaped XML', () => {
    const v = parsePermissionSet(SAMPLE);
    expect(v.label).toBe('Sales Ops');
    expect(v.license).toBe('Salesforce');
    expect(v.objectPermissions).toEqual([
      { object: 'Account', read: true, create: true, edit: true, delete: false, viewAll: true, modifyAll: false },
    ]);
    expect(v.fieldPermissions).toEqual([
      { field: 'Account.LF4_Region__c', readable: true, editable: false },
    ]);
    expect(v.userPermissions).toEqual([{ name: 'ExecutePromptTemplates', enabled: true }]);
    expect(v.classAccesses).toEqual([{ name: 'InvoiceService', enabled: true }]);
    expect(v.tabSettings).toEqual([{ tab: 'Account', visibility: 'Visible' }]);
  });

  it('is calm about minimal and malformed input', () => {
    expect(parsePermissionSet('<PermissionSet/>').objectPermissions).toEqual([]);
    expect(parsePermissionSet('not xml at all').label).toBeNull();
  });
});

describe('parsePermissionSet in linear time (slow-path follow-up)', () => {
  // The Manifest view parses the bytes of a deployed permission set, which
  // an agent wrote. The pattern this parser used started again from every
  // opener with no closer after it and read to the end (quadratic: seconds
  // for 1 MB of such openers). It must parse in well under a second, and the
  // same.
  const MB = 1_000_000;
  const fill = (unit: string, bytes = MB) => unit.repeat(Math.floor(bytes / unit.length));

  it('description and grant openers with no closer, packed close together', () => {
    const xml =
      '<PermissionSet><label>Ops</label><objectPermissions><allowRead>true</allowRead>' +
      '<object>Case</object></objectPermissions>' +
      fill('<description>', MB / 2) +
      fill('<objectPermissions>', MB / 2) +
      '</PermissionSet>';
    const started = performance.now();
    const view = parsePermissionSet(xml);
    const took = performance.now() - started;
    expect(view.label).toBe('Ops');
    expect(view.description).toBeNull();
    expect(view.objectPermissions).toEqual([
      {
        object: 'Case',
        read: true,
        create: false,
        edit: false,
        delete: false,
        viewAll: false,
        modifyAll: false,
      },
    ]);
    expect(took, `${Math.round(took)} ms`).toBeLessThan(1000);
  });
});
