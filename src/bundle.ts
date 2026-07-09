import {
  parsePlanDoc,
  parseRequirementsDoc,
  parseRoadmapDoc,
  parseStateDoc,
  serializeRequirementsBlock,
  serializeRoadmapBlock,
  serializeStateBlock,
} from './doc-parse.js';
import { ParseError } from './parse.js';
import type {
  PlanDoc,
  RequirementsDoc,
  RoadmapDoc,
  StateLedger,
} from './types.js';

export interface PlanBundle {
  planMarkdown: string;
  requirements: RequirementsDoc;
  roadmap: RoadmapDoc;
  state: StateLedger;
  plan: PlanDoc;
}

const MARKERS = {
  plan: '<!-- gpd:section=plan -->',
  requirements: '<!-- gpd:section=requirements -->',
  roadmap: '<!-- gpd:section=roadmap -->',
  state: '<!-- gpd:section=state -->',
} as const;

type SectionName = keyof typeof MARKERS;

function markerName(marker: string): SectionName | undefined {
  for (const [name, value] of Object.entries(MARKERS)) {
    if (value === marker) return name as SectionName;
  }
  return undefined;
}

export function parsePlanBundle(text: string): PlanBundle {
  const normalized = text.replace(/\r\n/g, '\n');
  const seen = new Map<SectionName, number>();
  const found: Array<{ name: SectionName; marker: string; start: number }> = [];
  let offset = 0;
  for (const line of normalized.split('\n')) {
    const name = markerName(line);
    if (name !== undefined) {
      if (seen.has(name)) {
        throw new ParseError(
          `Duplicate bundle marker: ${MARKERS[name]}`,
          'bundle',
        );
      }
      seen.set(name, offset);
      found.push({ name, marker: line, start: offset });
    }
    offset += line.length + 1;
  }

  for (const name of Object.keys(MARKERS) as SectionName[]) {
    if (!seen.has(name)) {
      throw new ParseError(`Missing bundle marker: ${MARKERS[name]}`, 'bundle');
    }
  }

  found.sort((a, b) => a.start - b.start);
  const sections = new Map<SectionName, string>();
  for (let i = 0; i < found.length; i++) {
    const current = found[i];
    const next = found[i + 1];
    if (!current) continue;
    const bodyStart = current.start + current.marker.length;
    const bodyEnd = next ? next.start : normalized.length;
    sections.set(current.name, normalized.slice(bodyStart, bodyEnd).trim());
  }

  try {
    const planMarkdown = sections.get('plan') ?? '';
    const requirementsText = sections.get('requirements') ?? '';
    const roadmapText = sections.get('roadmap') ?? '';
    const stateText = sections.get('state') ?? '';
    const plan = parsePlanDoc(planMarkdown);
    return {
      planMarkdown,
      requirements: parseRequirementsDoc(requirementsText),
      roadmap: parseRoadmapDoc(roadmapText),
      state: parseStateDoc(stateText),
      plan,
    };
  } catch (error) {
    if (error instanceof ParseError) {
      throw error;
    }
    throw new ParseError('Could not parse plan bundle.', 'bundle');
  }
}

export function serializePlanBundle(bundle: {
  planMarkdown: string;
  requirements: RequirementsDoc;
  roadmap: RoadmapDoc;
  state: StateLedger;
}): string {
  return (
    [
      MARKERS.plan,
      bundle.planMarkdown.trim(),
      MARKERS.requirements,
      serializeRequirementsBlock(bundle.requirements),
      MARKERS.roadmap,
      serializeRoadmapBlock(bundle.roadmap),
      MARKERS.state,
      serializeStateBlock(bundle.state),
    ].join('\n') + '\n'
  );
}
