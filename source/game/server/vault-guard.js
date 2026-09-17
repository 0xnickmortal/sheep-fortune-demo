import { first, stmt, guard } from './db.js';
import { GameError } from './rules.js';
export async function vaultControl(db, asset) {
  if (asset === 'demo') return null;
  await stmt(db, 'INSERT OR IGNORE INTO vault_controls(asset,revision) VALUES (?,0)', asset).run();
  return first(db, 'SELECT * FROM vault_controls WHERE asset=?', asset);
}
export function custodyGuard(db, control, burning = null) {
  if (!control) return [];
  if (control.burning) throw new GameError('奖池正在执行批量销毁，请稍后再操作', 409, 'BURN_IN_PROGRESS');
  return [stmt(db, 'UPDATE vault_controls SET revision=revision+1,burning=? WHERE asset=? AND revision=? AND burning IS NULL', burning, control.asset, control.revision), ...guard(db)];
}
