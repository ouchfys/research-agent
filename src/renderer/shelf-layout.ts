import type { Category, DocumentMeta } from '../shared/types';

export interface ShelfNode { id: string; kind: 'root' | 'category' | 'document'; x: number; y: number; width: number; height: number; category?: Category; document?: DocumentMeta }
export interface ShelfLayout { nodes: ShelfNode[]; lines: string[]; width: number; height: number; matches: number }

const WIDTH = 236, GAP = 42, FOLDER_HEIGHT = 62, LEVEL = 148, FILE_HEIGHT = 44, FILE_STEP = 56;
const elbow = (x: number, y: number, targetX: number, targetY: number) => {
  const mid = y + (targetY - y) / 2, direction = targetX >= x ? 1 : -1;
  const radius = Math.min(12, Math.abs(targetX - x) / 2, (targetY - y) / 4);
  return `M ${x} ${y} V ${mid - radius} Q ${x} ${mid} ${x + direction * radius} ${mid} H ${targetX - direction * radius} Q ${targetX} ${mid} ${targetX} ${mid + radius} V ${targetY}`;
};

/** Coordinates describe hierarchy only; document contents and category IDs stay untouched. */
export function buildShelfLayout(categories: Category[], documents: DocumentMeta[], collapsed: Set<string>, query: string): ShelfLayout {
  const search = query.trim().toLocaleLowerCase();
  const nodes: ShelfNode[] = [], lines: string[] = [];
  const byParent = new Map<string | null, Category[]>(), byCategory = new Map<string, DocumentMeta[]>();
  categories.forEach(category => byParent.set(category.parentId, [...(byParent.get(category.parentId) || []), category]));
  documents.forEach(document => byCategory.set(document.categoryId, [...(byCategory.get(document.categoryId) || []), document]));
  const matchesDocument = (document: DocumentMeta) => `${document.title} ${document.description} ${document.aliases.join(' ')} ${document.paperIds.join(' ')}`.toLocaleLowerCase().includes(search);
  type Branch = { category: Category; children: Branch[]; files: DocumentMeta[]; width: number };
  function branch(category: Category, inheritedMatch = false, ancestors = new Set<string>()): Branch | null {
    if (ancestors.has(category.id)) return null;
    const nextAncestors = new Set([...ancestors, category.id]);
    const all = !search || inheritedMatch || category.name.toLocaleLowerCase().includes(search);
    const open = Boolean(search) || !collapsed.has(category.id);
    const files = open ? (byCategory.get(category.id) || []).filter(document => all || matchesDocument(document)) : [];
    const children = open ? (byParent.get(category.id) || []).map(child => branch(child, all, nextAncestors)).filter((item): item is Branch => Boolean(item)) : [];
    if (search && !all && !files.length && !children.length) return null;
    const lanes = [...(files.length ? [WIDTH] : []), ...children.map(child => child.width)];
    return { category, children, files, width: Math.max(WIDTH, lanes.reduce((sum, width) => sum + width, 0) + Math.max(0, lanes.length - 1) * GAP) };
  }
  const roots = (byParent.get(null) || []).map(category => branch(category)).filter((item): item is Branch => Boolean(item));
  // Preserve visibility for legacy orphaned categories without changing their stored parent.
  categories.filter(category => category.parentId && !categories.some(parent => parent.id === category.parentId)).forEach(category => { const item = branch(category); if (item) roots.push(item); });
  const forestWidth = roots.reduce((sum, item) => sum + item.width, 0) + Math.max(0, roots.length - 1) * 76;
  const width = Math.max(820, forestWidth + 112);
  nodes.push({ id: 'shelf-root', kind: 'root', x: (width - 248) / 2, y: 38, width: 248, height: 68 });
  function place(item: Branch, left: number, y: number) {
    const x = left + (item.width - WIDTH) / 2;
    nodes.push({ id: item.category.id, kind: 'category', category: item.category, x, y, width: WIDTH, height: FOLDER_HEIGHT });
    let laneX = left;
    if (item.files.length) {
      const stemX = laneX + 12, startY = y + FOLDER_HEIGHT;
      if (Math.abs(stemX - (x + 14)) > 1) lines.push(elbow(x + WIDTH / 2, startY, stemX, y + LEVEL - 24));
      else lines.push(`M ${stemX} ${startY} V ${y + LEVEL - 24}`);
      item.files.forEach((document, index) => {
        const fileY = y + LEVEL + index * FILE_STEP;
        nodes.push({ id: document.id, kind: 'document', document, x: laneX + 26, y: fileY, width: WIDTH - 26, height: FILE_HEIGHT });
        const middle = fileY + FILE_HEIGHT / 2;
        lines.push(`M ${stemX} ${y + LEVEL - 24} V ${middle - 10} Q ${stemX} ${middle} ${stemX + 10} ${middle} H ${laneX + 26}`);
      });
      laneX += WIDTH + GAP;
    }
    item.children.forEach(child => {
      const childX = laneX + child.width / 2;
      lines.push(elbow(x + WIDTH / 2, y + FOLDER_HEIGHT, childX, y + LEVEL));
      place(child, laneX, y + LEVEL);
      laneX += child.width + GAP;
    });
  }
  let left = (width - forestWidth) / 2;
  roots.forEach(item => {
    lines.push(elbow(width / 2, 106, left + item.width / 2, 202));
    place(item, left, 202); left += item.width + 76;
  });
  return { nodes, lines, width, height: Math.max(560, ...nodes.map(node => node.y + node.height + 104)), matches: nodes.filter(node => node.kind === 'document').length };
}
