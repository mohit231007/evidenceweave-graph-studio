import type { EntityCandidateRecord, RelationCandidateRecord } from "./store";
import type { UnifiedSourceBlock } from "./hybrid";

export interface GoldenQuestion {
  id: string;
  question: string;
  relevantBlockIds: string[];
  kind: "exact" | "semantic" | "multi-hop" | "temporal" | "negative";
}

const stamp = "2026-09-06T00:00:00.000Z";

export const goldenBlocks: UnifiedSourceBlock[] = [
  { id: "g-storage", sourceType: "note", sourceId: "n-architecture", title: "Architecture", headingPath: ["Storage"], text: "EvidenceWeave stores authored notes locally in IndexedDB and does not require a server-side document database." },
  { id: "g-provenance", sourceType: "document", sourceId: "d-design", title: "Design Report", headingPath: ["Evidence"], text: "Every inferred relationship must resolve to one or more immutable source blocks with provenance." },
  { id: "g-atlas-openai", sourceType: "document", sourceId: "d-atlas", title: "Atlas Spec", headingPath: ["Dependencies"], text: "Project Atlas uses OpenAI for an optional local experimentation workflow." },
  { id: "g-openai-microsoft", sourceType: "document", sourceId: "d-partnership", title: "Partnership History", headingPath: ["2019"], text: "OpenAI partnered with Microsoft in 2019." },
  { id: "g-temporal-old", sourceType: "document", sourceId: "d-history", title: "History", headingPath: ["2017"], text: "In 2017 the prototype used a remote search service." },
  { id: "g-temporal-new", sourceType: "document", sourceId: "d-history", title: "History", headingPath: ["2026"], text: "In 2026 EvidenceWeave uses a local-first browser retrieval stack." },
  { id: "g-noise", sourceType: "document", sourceId: "d-noise", title: "Unrelated", headingPath: [], text: "Bicycles, oranges and weather forecasts are unrelated to this knowledge workspace." }
];

export const goldenEntities: EntityCandidateRecord[] = [
  { id: "e-atlas", canonicalName: "Project Atlas", normalizedName: "project atlas", entityType: "project", evidenceBlockIds: ["g-atlas-openai"], confidence: .95, extractorVersion: "golden-v1", status: "accepted", aliases: ["Atlas"], updatedAt: stamp },
  { id: "e-openai", canonicalName: "OpenAI", normalizedName: "openai", entityType: "organization", evidenceBlockIds: ["g-atlas-openai", "g-openai-microsoft"], confidence: .95, extractorVersion: "golden-v1", status: "accepted", aliases: [], updatedAt: stamp },
  { id: "e-microsoft", canonicalName: "Microsoft", normalizedName: "microsoft", entityType: "organization", evidenceBlockIds: ["g-openai-microsoft"], confidence: .95, extractorVersion: "golden-v1", status: "accepted", aliases: [], updatedAt: stamp }
];

export const goldenRelations: RelationCandidateRecord[] = [
  { id: "r-atlas-openai", sourceEntityId: "e-atlas", targetEntityId: "e-openai", relation: "uses", evidenceBlockIds: ["g-atlas-openai"], confidence: .95, extractorVersion: "golden-v1", status: "accepted", observedAt: stamp, updatedAt: stamp },
  { id: "r-openai-microsoft", sourceEntityId: "e-openai", targetEntityId: "e-microsoft", relation: "partnered-with", evidenceBlockIds: ["g-openai-microsoft"], confidence: .95, extractorVersion: "golden-v1", status: "accepted", validFrom: "2019-01-01", observedAt: stamp, updatedAt: stamp }
];

export const goldenQuestions: GoldenQuestion[] = [
  { id: "q-storage", question: "Where does EvidenceWeave store authored notes?", relevantBlockIds: ["g-storage"], kind: "exact" },
  { id: "q-provenance", question: "What is required before an inferred relationship can be trusted?", relevantBlockIds: ["g-provenance"], kind: "semantic" },
  { id: "q-path", question: "How does Project Atlas relate to Microsoft?", relevantBlockIds: ["g-atlas-openai", "g-openai-microsoft"], kind: "multi-hop" },
  { id: "q-temporal", question: "What does EvidenceWeave use in 2026?", relevantBlockIds: ["g-temporal-new"], kind: "temporal" },
  { id: "q-negative", question: "What was Apple revenue in 2024?", relevantBlockIds: [], kind: "negative" }
];
