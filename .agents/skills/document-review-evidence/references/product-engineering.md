# Overlay: product-engineering

Criteria for reviewing formal product and engineering documents: PRDs, technical solutions, architecture and interface designs, project delivery documents, ADRs. Apply together with core.md; core rules win on conflict.

- **Terminology consistency** — terms match the document's established usage and linked contracts (interfaces, metrics, cross-references) are synchronized with the change.
- **Decision-state integrity** — confirmed facts, recommendations, pending decisions, assumptions, and unknowns stay distinct; no proposal is promoted to a decision without an ADR or explicit dispatch confirmation.
- **Acceptance criteria** — present and testable where the document type requires them; the change is consistent with existing acceptance criteria.
- **Protected content** — untouched unless the dispatch explicitly changes it; unchanged ranges appear unchanged in the validated snapshot.
- **Structure and resources** — structure, links, tables, embeds, and resource relationships preserved unless the change explicitly alters them; a preservation claim must be backed per core.md baseline rules — a verified scoped baseline artifact or paired matching hashes over the same precisely located content.
