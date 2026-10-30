export type JournalEntry = { idx: number; tag: string; when: number; hash: string };
export type SchemaState = {
  status: "ok" | "missing" | "newer" | "uninitialized";
  required: number;
  applied: number;
  missing: string[];
  unknown: number;
};
export function readJournal(migrationsFolder: string): JournalEntry[];
export function evaluateSchema(journal: JournalEntry[], applied: { hash: string }[] | null): SchemaState;
export function readApplied(queryable: { query(sql: string): Promise<{ rows: any[] }> }): Promise<{ hash: string }[] | null>;
export function checkSchema(queryable: { query(sql: string): Promise<{ rows: any[] }> }, migrationsFolder: string): Promise<SchemaState>;
export function describeSchemaState(state: SchemaState): { headline: string; detail: string } | null;
