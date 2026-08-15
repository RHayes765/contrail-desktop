import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { diffFlowNodes, parseFlowGraph } from '../metadata/flowgraph.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>High Priority Router</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Case</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <scheduledPaths>
            <name>Delay</name>
            <label>1 minute later</label>
            <connector><targetReference>Check_Priority</targetReference></connector>
        </scheduledPaths>
    </start>
    <decisions>
        <name>Check_Priority</name>
        <label>Check Priority</label>
        <rules>
            <name>Is_High</name>
            <label>Is High</label>
            <connector><targetReference>Create_Channel</targetReference></connector>
        </rules>
        <defaultConnector><targetReference>Log_Skip</targetReference></defaultConnector>
        <defaultConnectorLabel>Not high</defaultConnectorLabel>
    </decisions>
    <actionCalls>
        <name>Create_Channel</name>
        <label>Create Slack Channel</label>
        <actionName>CreateSlackRecordChannel</actionName>
        <connector><targetReference>Done</targetReference></connector>
        <faultConnector><targetReference>Log_Skip</targetReference></faultConnector>
    </actionCalls>
    <assignments>
        <name>Log_Skip</name>
        <label>Log Skip</label>
    </assignments>
    <assignments>
        <name>Done</name>
        <label>Done</label>
    </assignments>
</Flow>`;

describe('parseFlowGraph', () => {
  it('parses nodes, labeled edges, faults, and trigger facts', () => {
    const g = parseFlowGraph(SAMPLE);
    expect(g.label).toBe('High Priority Router');
    expect(g.trigger).toBe('RecordAfterSave on CreateAndUpdate of Case');
    expect(g.nodes.map((n) => n.name)).toEqual(
      expect.arrayContaining(['__start', 'Check_Priority', 'Create_Channel', 'Log_Skip', 'Done']),
    );
    expect(g.nodes.find((n) => n.name === 'Create_Channel')?.detail).toBe('CreateSlackRecordChannel');
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { from: '__start', to: 'Check_Priority', kind: 'normal', label: '1 minute later' },
        { from: 'Check_Priority', to: 'Create_Channel', kind: 'decision', label: 'Is High' },
        { from: 'Check_Priority', to: 'Log_Skip', kind: 'decision', label: 'Not high' },
        { from: 'Create_Channel', to: 'Done', kind: 'normal', label: null },
        { from: 'Create_Channel', to: 'Log_Skip', kind: 'fault', label: 'fault' },
      ]),
    );
    expect(g.unresolved).toEqual([]);
  });

  it('parses every flow in every local snapshot without unresolved targets', () => {
    const snapshotsDir = path.join(process.env.LOCALAPPDATA ?? '', 'Contrail/snapshots');
    if (!fs.existsSync(snapshotsDir)) return; // machine without the shared data dir
    let checked = 0;
    for (const conn of fs.readdirSync(snapshotsDir)) {
      const flowsDir = path.join(snapshotsDir, conn, 'current', 'flows');
      if (!fs.existsSync(flowsDir)) continue;
      for (const file of fs.readdirSync(flowsDir)) {
        if (!file.endsWith('.flow')) continue;
        const g = parseFlowGraph(fs.readFileSync(path.join(flowsDir, file), 'utf8'));
        expect(g.nodes.length, `${conn}/${file}`).toBeGreaterThan(0);
        expect(g.unresolved, `${conn}/${file}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('inspector props', () => {
  it('extracts decision criteria, start entry conditions, and scheduled paths', () => {
    const g = parseFlowGraph(`<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <start>
    <object>Case</object>
    <triggerType>RecordAfterSave</triggerType>
    <filterLogic>and</filterLogic>
    <filters><field>Priority</field><operator>EqualTo</operator><value><stringValue>High</stringValue></value></filters>
    <filters><field>IsClosed</field><operator>EqualTo</operator><value><booleanValue>false</booleanValue></value></filters>
    <scheduledPaths>
      <name>Delay</name><label>Delayed</label>
      <offsetNumber>1</offsetNumber><offsetUnit>Minutes</offsetUnit>
      <connector><targetReference>Check</targetReference></connector>
    </scheduledPaths>
  </start>
  <decisions>
    <name>Check</name><label>Check</label>
    <rules>
      <name>Is_Big</name><label>Is Big</label>
      <conditionLogic>and</conditionLogic>
      <conditions><leftValueReference>$Record.Amount</leftValueReference><operator>GreaterThan</operator><rightValue><numberValue>100</numberValue></rightValue></conditions>
      <connector><targetReference>Fetch</targetReference></connector>
    </rules>
  </decisions>
  <recordLookups>
    <name>Fetch</name><label>Fetch</label>
    <object>Asset</object>
    <filters><field>Status</field><operator>EqualTo</operator><value><stringValue>Active</stringValue></value></filters>
    <getFirstRecordOnly>true</getFirstRecordOnly>
  </recordLookups>
</Flow>`);
    const start = g.nodes.find((n) => n.name === '__start');
    expect(start?.props).toEqual(
      expect.arrayContaining([
        { name: 'entry criteria', value: 'Priority EqualTo High AND IsClosed EqualTo false' },
        { name: 'path: Delayed', value: '1 Minutes' },
      ]),
    );
    const decision = g.nodes.find((n) => n.name === 'Check');
    expect(decision?.props).toEqual([
      { name: 'Is Big', value: '$Record.Amount GreaterThan 100' },
    ]);
    const lookup = g.nodes.find((n) => n.name === 'Fetch');
    expect(lookup?.props).toEqual(
      expect.arrayContaining([
        { name: 'object', value: 'Asset' },
        { name: 'filters', value: 'Status EqualTo Active' },
        { name: 'first record only', value: 'true' },
      ]),
    );
    expect(lookup?.xml).toContain('<object>Asset</object>');
  });
});

describe('diffFlowNodes', () => {
  const V1 = `<Flow xmlns="x"><label>F</label>
    <decisions><name>Check</name><label>Check</label>
      <rules><name>R</name><conditions><leftValueReference>A</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>1</stringValue></rightValue></conditions></rules>
    </decisions>
    <assignments><name>SetX</name><label>Set X</label></assignments>
    <assignments><name>Old</name><label>Old</label></assignments>
  </Flow>`;
  const V2 = `<Flow xmlns="x"><label>F</label>
    <decisions><name>Check</name><label>Check</label>
      <rules><name>R</name><conditions><leftValueReference>A</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>2</stringValue></rightValue></conditions></rules>
    </decisions>
    <assignments><name>SetX</name>
      <label>Set X</label></assignments>
    <actionCalls><name>Notify</name><label>Notify</label><actionName>emailSimple</actionName></actionCalls>
  </Flow>`;

  it('classifies changed, added, and removed nodes; whitespace never counts', () => {
    const result = diffFlowNodes(parseFlowGraph(V1), parseFlowGraph(V2));
    expect(result.changed).toEqual(['Check']); // rightValue 1 → 2
    expect(result.addedInB).toEqual(['Notify']);
    expect(result.removedInB).toEqual(['Old']);
    // SetX reformatted only → not changed; identical flows → all empty
    const same = diffFlowNodes(parseFlowGraph(V1), parseFlowGraph(V1));
    expect(same).toEqual({ changed: [], addedInB: [], removedInB: [] });
  });
});
