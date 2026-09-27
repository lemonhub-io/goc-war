/* tslint:disable */
/* eslint-disable */

export class BooksSim {
    free(): void;
    [Symbol.dispose](): void;
    cols_len(): number;
    cols_ptr(): number;
    count(): number;
    mats_len(): number;
    /**
     * pointer/len pairs for zero-copy views over wasm linear memory
     */
    mats_ptr(): number;
    constructor(n: number);
    reset(): void;
    /**
     * per-frame book update — fills mats[] and cols[]
     */
    update(t: number, strike: number, _breach: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bookssim_free: (a: number, b: number) => void;
    readonly bookssim_cols_len: (a: number) => number;
    readonly bookssim_cols_ptr: (a: number) => number;
    readonly bookssim_count: (a: number) => number;
    readonly bookssim_mats_len: (a: number) => number;
    readonly bookssim_mats_ptr: (a: number) => number;
    readonly bookssim_new: (a: number) => number;
    readonly bookssim_reset: (a: number) => void;
    readonly bookssim_update: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
