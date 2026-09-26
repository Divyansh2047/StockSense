import { Check, PencilSimple, Plus, Tag, Trash, X } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '../components/Dialog';
import { Button, Empty, ErrorBox, PageHeader, SkeletonRows } from '../components/ui';
import { del, errorMessage, patch, post } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { queryClient, useCategories, useMe } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Category } from '../lib/types';

export default function Categories() {
  useDocumentTitle('Categories');
  const { data: me } = useMe();
  const { data, error, isLoading, refetch } = useCategories();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [removing, setRemoving] = useState<Category | null>(null);
  const toast = useToast();
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['categories'] }), queryClient.invalidateQueries({ queryKey: ['products'] })]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await post('/categories', { name: name.trim() });
      await refresh();
      toast.success(`Category “${name.trim()}” added`);
      setName('');
    } catch (err) {
      toast.error('Could not add', errorMessage(err));
    }
  };
  const rename = async (e: FormEvent, id: number) => {
    e.preventDefault();
    try {
      await patch(`/categories/${id}`, { name: editName.trim() });
      await refresh();
      setEditing(null);
    } catch (err) {
      toast.error('Could not rename', errorMessage(err));
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await del(`/categories/${removing.id}`);
      await refresh();
      toast.success(`${removing.name} removed`);
    } catch (err) {
      toast.error('Could not remove', errorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <PageHeader title="Categories" meta={<span>Group products so the dashboard and stock views can filter by them.</span>} />
      <form className="toolbar" onSubmit={add}>
        <input className="input grow" placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New category name" />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          <Plus size={17} weight="bold" /> Add
        </Button>
      </form>
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel">
          {isLoading ? (
            <SkeletonRows rows={4} cols={3} />
          ) : !data?.length ? (
            <Empty icon={<Tag size={38} weight="duotone" />} title="No categories yet">
              Furniture, raw material, packaging: whatever your team uses to talk about stock.
            </Empty>
          ) : (
            <ul className="catlist">
              {data.map((c) => (
                <li key={c.id}>
                  {editing === c.id ? (
                    <form className="catlist__edit" onSubmit={(e) => rename(e, c.id)}>
                      <input className="input" autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Category name" onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                      <Button type="submit" size="sm" variant="primary" aria-label="Save">
                        <Check size={15} weight="bold" />
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setEditing(null)} aria-label="Cancel">
                        <X size={15} />
                      </Button>
                    </form>
                  ) : (
                    <>
                      <Tag size={18} className="c-accent" aria-hidden="true" />
                      <span className="catlist__name">{c.name}</span>
                      <Link to={`/products?category=${c.id}`} className="muted" style={{ fontSize: 13 }}>
                        {c.productCount} {c.productCount === 1 ? 'product' : 'products'}
                      </Link>
                      <Button size="xs" variant="quiet" onClick={() => (setEditing(c.id), setEditName(c.name))} aria-label={`Rename ${c.name}`}>
                        <PencilSimple size={15} />
                      </Button>
                      {me?.role === 'manager' && (
                        <Button size="xs" variant="quiet" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`}>
                          <Trash size={15} />
                        </Button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} title={`Remove ${removing?.name ?? ''}?`} confirmLabel="Remove">
        Products in this category stay, they just lose the category.
      </ConfirmDialog>
    </div>
  );
}
