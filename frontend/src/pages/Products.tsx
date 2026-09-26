import { MagnifyingGlass, Package, Plus } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';
import { Empty, ErrorBox, PageHeader, SkeletonRows, StockPill } from '../components/ui';
import { money, qty, uom } from '../lib/format';
import { useDebounced, useDocumentTitle, useQueryState } from '../lib/hooks';
import { useCategories, useProducts } from '../lib/queries';

export default function Products() {
  useDocumentTitle('Products');
  const navigate = useNavigate();
  const [search, setSearch] = useQueryState('q');
  const [categoryId, setCategory] = useQueryState('category');
  const [archived, setArchived] = useQueryState('archived');
  const term = useDebounced(search);
  const { data, error, isLoading, isFetching, refetch } = useProducts({ search: term, categoryId, archived: archived || undefined });
  const { data: categories = [] } = useCategories();

  return (
    <div>
      <PageHeader
        title="Products"
        meta={<span>SKUs, units, costs and the reorder rules behind the low-stock alerts.</span>}
        actions={
          <Link className="btn btn--primary" to="/products/new">
            <Plus size={17} weight="bold" /> New product
          </Link>
        }
      />
      <div className="toolbar">
        <div className="input-icon grow">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search SKU or name" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search SKU or name" />
        </div>
        <select className="select" aria-label="Category" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.productCount})
            </option>
          ))}
        </select>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={archived === 'true'} onChange={(e) => setArchived(e.target.checked ? 'true' : '')} /> Show archived
        </label>
      </div>
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel" style={{ opacity: isFetching && !isLoading ? 0.7 : 1, transition: 'opacity .2s' }}>
          {isLoading ? (
            <SkeletonRows cols={7} />
          ) : !data?.length ? (
            <Empty
              icon={<Package size={38} weight="duotone" />}
              title={search ? 'No products match' : 'No products yet'}
              action={
                <Link className="btn btn--primary btn--sm" to="/products/new">
                  <Plus size={15} weight="bold" /> New product
                </Link>
              }
            >
              {search ? 'Try part of the SKU or the name.' : 'Add your first product with its SKU, unit and reorder point.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Category</th>
                    <th className="n">Unit cost</th>
                    <th className="n">On hand</th>
                    <th className="n">Free</th>
                    <th className="n">Reorder at</th>
                    <th>Level</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((p) => (
                    <tr key={p.id} className="is-link" onClick={() => navigate(`/products/${p.id}`)}>
                      <td className="ref">
                        <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>
                          {p.sku}
                        </Link>
                      </td>
                      <td className="cell-main">{p.name}</td>
                      <td>{p.categoryName ?? <span className="muted">None</span>}</td>
                      <td className="n">{money(p.unitCost)}</td>
                      <td className="n">
                        {qty(p.onHand)} <span className="muted">{uom(p.uom)}</span>
                      </td>
                      <td className="n">{qty(p.free)}</td>
                      <td className="n">{p.reorderMin > 0 ? qty(p.reorderMin) : <span className="muted">Off</span>}</td>
                      <td>{p.archived ? <span className="pill">Archived</span> : <StockPill status={p.stockStatus} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
