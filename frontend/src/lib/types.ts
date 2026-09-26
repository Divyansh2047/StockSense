export type Role = 'manager' | 'staff';
export type OpType = 'receipt' | 'delivery' | 'internal' | 'adjustment';
export type OpStatus = 'draft' | 'waiting' | 'ready' | 'done' | 'canceled';
export type Direction = 'in' | 'out' | 'internal';

export interface User {
  id: number;
  loginId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  emailVerified: boolean;
  company: { id: number; name: string; sandbox: boolean };
}

export interface TeamMember {
  id: number;
  loginId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
  emailVerified: boolean;
}

export interface Verification {
  email: string;
  masked: string;
  resendIn: number;
  sent: boolean;
}

export interface Warehouse {
  id: number;
  name: string;
  shortCode: string;
  address: string;
  locationCount: number;
  unitsOnHand: number;
  openOperations: number;
}

export interface Location {
  id: number;
  name: string;
  shortCode: string;
  type: 'internal' | 'vendor' | 'customer' | 'inventory';
  warehouseId: number | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  fullName: string;
  unitsOnHand: number;
  productCount: number;
}

export interface Category {
  id: number;
  name: string;
  productCount: number;
}

export type StockStatus = 'ok' | 'low' | 'out';

export interface Product {
  id: number;
  name: string;
  sku: string;
  uom: string;
  unitCost: number;
  reorderMin: number;
  reorderMax: number;
  archived: boolean;
  categoryId: number | null;
  categoryName: string | null;
  onHand: number;
  reserved: number;
  free: number;
  stockStatus: StockStatus;
}

export interface ProductDetail extends Product {
  createdAt: string;
  locations: {
    locationId: number;
    fullName: string;
    name: string;
    warehouseId: number;
    warehouseName: string;
    quantity: number;
    reserved: number;
    free: number;
  }[];
}

export interface StockRow extends Product {
  value: number;
  locations: { locationId: number; fullName: string; quantity: number; reserved: number }[];
}

export interface Partner {
  id: number;
  name: string;
  kind: 'vendor' | 'customer' | 'both';
  email: string;
  phone: string;
  address: string;
  operationCount?: number;
}

export interface OperationSummary {
  id: number;
  reference: string;
  type: OpType;
  status: OpStatus;
  scheduledDate: string;
  createdAt: string;
  validatedAt: string | null;
  warehouseId: number;
  warehouseCode: string;
  partnerId: number | null;
  partnerName: string | null;
  sourceLocationId: number;
  destLocationId: number;
  sourceName: string;
  destName: string;
  responsibleId: number | null;
  responsibleName: string | null;
  late: boolean;
  lineCount: number;
  totalQuantity: number;
}

export interface OperationLine {
  id: number;
  productId: number;
  productName: string;
  sku: string;
  uom: string;
  quantity: number;
  reserved: number;
  systemQuantity: number | null;
  onHand: number;
  available: number;
}

export interface Operation extends OperationSummary {
  deliveryAddress: string;
  notes: string;
  validatedByName: string | null;
  createdByName: string | null;
  lines: OperationLine[];
  shortages?: { productId: number; needed: number; available: number }[];
  readied?: number[];
}

export interface Move {
  key: string;
  operationId: number | null;
  reference: string;
  kind: OpType;
  status: OpStatus;
  date: string;
  quantity: number;
  productId: number;
  productName: string;
  sku: string;
  uom: string;
  fromId: number;
  fromType: Location['type'];
  fromName: string;
  toId: number;
  toType: Location['type'];
  toName: string;
  partnerName: string | null;
  userName: string | null;
  direction: Direction;
}

export interface CardStats {
  pending: number;
  ready: number;
  waiting: number;
  late: number;
  upcoming: number;
  today: number;
}

export interface Dashboard {
  kpis: {
    productsInStock: number;
    productCount: number;
    unitsOnHand: number;
    unitsReserved: number;
    stockValue: number;
    lowStock: number;
    outOfStock: number;
    pendingReceipts: number;
    pendingDeliveries: number;
    internalScheduled: number;
    waitingDeliveries: number;
  };
  cards: Record<OpType, CardStats>;
  movement: { date: string; inValue: number; outValue: number; inMoves: number; outMoves: number }[];
  lowStock: { id: number; name: string; sku: string; uom: string; reorderMin: number; reorderMax: number; onHand: number; incoming: number }[];
  operations: OperationSummary[];
  recentMoves: {
    id: number;
    reference: string;
    kind: OpType;
    quantity: number;
    date: string;
    productName: string;
    uom: string;
    direction: Direction;
    fromName: string;
    toName: string;
  }[];
}
