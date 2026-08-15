import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFlowGraph } from '../metadata/flowgraph.js';

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

  it('parses every real dev-org flow without unresolved targets', () => {
    const flowsDir = path.join(
      process.env.LOCALAPPDATA ?? '',
      'Contrail/snapshots/97ed71a0-40b4-44e3-83b5-3ffd5eccf856/current/flows',
    );
    if (!fs.existsSync(flowsDir)) return; // machine without the shared snapshot
    for (const file of fs.readdirSync(flowsDir)) {
      const g = parseFlowGraph(fs.readFileSync(path.join(flowsDir, file), 'utf8'));
      expect(g.nodes.length, file).toBeGreaterThan(0);
      expect(g.unresolved, file).toEqual([]);
    }
  });
});
