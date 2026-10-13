import type { Category } from '../shared/types';

export function categoryPath(categories: Category[], id: string | null | undefined): string {
  if (!id) return '';
  const names: string[] = [];
  const visited = new Set<string>();
  let current = categories.find(category => category.id === id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    const parentId: string | null = current.parentId;
    current = parentId ? categories.find(category => category.id === parentId) : undefined;
  }
  return names.join(' / ');
}
