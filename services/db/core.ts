import BetterSqlite3 from "better-sqlite3";
import debug from "debug";
import fs from "fs";
import path from "path";

const log = debug("db");

const QUERIES_DIRNAME = path.resolve(__dirname, "queries");
const MIGRATIONS_DIRNAME = path.resolve(__dirname, "migrations");
const DATABASE_DIRNAME = path.resolve(__dirname, "data");

export type AnyFn = (...args: any[]) => any;

export type QueryFactoryContext<DB, K extends string> = {
  db: DB;
  name: K; // function name, e.g. "Initialize"
  sqlFilename: string;
  sql: string;
};

export type QuerySpec<DB, K extends string, F extends AnyFn> =
  | {
      file?: string;
      migration?: true;
      build: (ctx: QueryFactoryContext<DB, K>) => F;
    }
  | ((ctx: QueryFactoryContext<DB, K>) => F);

export type QuerySpecs<M extends Record<string, AnyFn>, DB> = {
  [K in keyof M & string]: QuerySpec<DB, K, M[K]>;
};

export class Database<M extends Record<string, AnyFn>> extends BetterSqlite3 {
  public readonly queries: M;
  public readonly dirname: string;

  constructor(
    public readonly dbName: string,
    specs: QuerySpecs<M, Database<M>>,
    options?: BetterSqlite3.Options
  ) {
    const dirname = path.join(DATABASE_DIRNAME, dbName);
    const filepath = path.join(dirname, "./db.sqlite3");
    const built: M = Object.create(null);

    fs.mkdirSync(dirname, { recursive: true });

    super(filepath, options);

    for (const name in specs) {
      const spec = specs[name];
      const {
        file: sqlFilename = name,
        migration,
        build,
      } = typeof spec === "function" ? { build: spec } : spec;
      const dirname = migration ? MIGRATIONS_DIRNAME : QUERIES_DIRNAME;
      const filepaths = [path.join(dirname, sqlFilename)];

      if (!sqlFilename.endsWith(".sql")) {
        filepaths.unshift(path.join(dirname, `${sqlFilename}.sql`));
      }

      const filepath = filepaths.find((filepath) => fs.existsSync(filepath));

      if (!filepath) {
        throw new Error(`Database SQL not found: ${filepaths.at(0)}`);
      }

      const sql = fs.readFileSync(filepath, "utf8");

      built[name as keyof M] = build({ db: this, name, sqlFilename, sql });
    }

    this.dirname = dirname;
    this.queries = built;
  }

  log(...args: any[]) {
    return log(`[${this.dbName}]`, ...args);
  }
}
