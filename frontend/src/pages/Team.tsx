import { UsersThree } from '@phosphor-icons/react';
import { Empty, ErrorBox, PageHeader, SkeletonRows } from '../components/ui';
import { errorMessage, patch } from '../lib/api';
import { dateTime, initials } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { queryClient, useMe, useTeam } from '../lib/queries';
import { useToast } from '../lib/toast';
import type { Role } from '../lib/types';

export default function Team() {
  useDocumentTitle('Team');
  const { data: me } = useMe();
  const { data, error, isLoading, refetch } = useTeam();
  const toast = useToast();
  const canEdit = me?.role === 'manager';

  const setRole = async (id: number, role: Role, name: string) => {
    try {
      await patch(`/users/${id}/role`, { role });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(`${name} is now ${role === 'manager' ? 'an inventory manager' : 'warehouse staff'}`);
    } catch (err) {
      toast.error('Could not change the role', errorMessage(err));
    }
  };

  return (
    <div style={{ maxWidth: 980 }}>
      <PageHeader
        title="Team"
        meta={<span>Managers run settings and the catalog. Staff receive, pick, ship, transfer and count.</span>}
      />
      {error ? (
        <ErrorBox error={error} retry={() => refetch()} />
      ) : (
        <div className="panel">
          {isLoading ? (
            <SkeletonRows rows={3} cols={4} />
          ) : !data?.length ? (
            <Empty icon={<UsersThree size={38} weight="duotone" />} title="Just you so far">
              Teammates appear here after they sign up.
            </Empty>
          ) : (
            <ul className="team">
              {data.map((u) => (
                <li key={u.id}>
                  <span className="avatar" aria-hidden="true">
                    {initials(u.name)}
                  </span>
                  <div className="team__who">
                    <b>
                      {u.name}
                      {u.id === me?.id ? ' (you)' : ''}
                    </b>
                    <span className="mono">
                      {u.loginId}  {u.email}
                    </span>
                  </div>
                  <span className="muted team__since">Joined {dateTime(u.createdAt)}</span>
                  {canEdit && u.id !== me?.id ? (
                    <select className="select" value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => setRole(u.id, e.target.value as Role, u.name)}>
                      <option value="manager">Inventory manager</option>
                      <option value="staff">Warehouse staff</option>
                    </select>
                  ) : (
                    <span className="tag">{u.role === 'manager' ? 'Inventory manager' : 'Warehouse staff'}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
