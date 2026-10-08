/* tslint:disable */
/* eslint-disable */

/**
 * One immutable deck data generation reused across recommendations.
 */
export class DeckSolver {
    free(): void;
    [Symbol.dispose](): void;
    batch(payload: string): string;
    /**
     * Formats, supported goals/metrics and explicit limitations of this build, as JSON text.
     */
    capabilities(): string;
    /**
     * Original UTF-8 deck-data bytes (`Uint8Array`), or original text for legacy callers.
     * Invalid UTF-8 is rejected; no replacement decoding or integer parsing changes the dataset hash.
     */
    constructor(deck_data: any);
    /**
     * `ournotes.account/1` + `ournotes-deck.recommendation-request/2` -> account-recommendation/1.
     * Every progress callback receives a whole answer with `final:false`; terminate the Worker to cancel.
     * Legacy owned-snapshot inputs retain their former request and result formats for existing harness callers.
     */
    recommend(account_json: string, request_json: string, on_progress?: (resultJson: string) => void | null, progress_interval_ms?: number | null): string;
    /**
     * SHA-256 of the original deck-data bytes, including any UTF-8 BOM.
     */
    readonly datasetId: string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decksolver_free: (a: number, b: number) => void;
    readonly decksolver_batch: (a: number, b: number, c: number) => [number, number];
    readonly decksolver_capabilities: (a: number) => [number, number];
    readonly decksolver_datasetId: (a: number) => [number, number];
    readonly decksolver_new: (a: any) => [number, number, number];
    readonly decksolver_recommend: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
