"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const ErrorUtils_1 = tslib_1.__importDefault(require("fbjs/lib/ErrorUtils"));
const invariant_1 = tslib_1.__importDefault(require("fbjs/lib/invariant"));
const normalizeRelayPayload_1 = tslib_1.__importDefault(require("relay-runtime/lib/normalizeRelayPayload"));
const RelayRecordSource_1 = tslib_1.__importDefault(require("relay-runtime/lib/RelayRecordSource"));
const RelayReader_1 = tslib_1.__importDefault(require("relay-runtime/lib/RelayReader"));
const RelayRecordSourceMutator_1 = tslib_1.__importDefault(require("relay-runtime/lib/RelayRecordSourceMutator"));
const RelayRecordSourceProxy_1 = tslib_1.__importDefault(require("relay-runtime/lib/RelayRecordSourceProxy"));
const RelayRecordSourceSelectorProxy_1 = tslib_1.__importDefault(require("relay-runtime/lib/RelayRecordSourceSelectorProxy"));
/**
 * Coordinates the concurrent modification of a `Store`
 * due to client, server, and optimistic updates
 * - Applies updates linearly
 * - Executes handlers for "handle" fields
 * - Rebases whenever an optimistic update is committed or reverted
 */
class LinearPublishQueue {
    constructor(store, handlerProvider, getDataID) {
        this._backup = RelayRecordSource_1.default.create();
        this._currentStoreIdx = 0;
        this._gcHold = null;
        this._getDataID = getDataID;
        this._handlerProvider = handlerProvider || null;
        this._pendingBackupRebase = false;
        this._pendingUpdates = [];
        this._store = store;
    }
    /**
     * Schedule applying an optimistic updates on the next `run()`.
     */
    applyUpdate(updater) {
        invariant_1.default(findUpdaterIdx(this._pendingUpdates, updater) === -1, 'LinearPublishQueue: Cannot apply the same update function more than ' + 'once concurrently.');
        this._pendingUpdates.push({ kind: 'optimistic', updater });
    }
    /**
     * Schedule reverting an optimistic updates on the next `run()`.
     */
    revertUpdate(updater) {
        const updateIdx = findUpdaterIdx(this._pendingUpdates, updater);
        if (updateIdx !== -1) {
            this._pendingBackupRebase = true;
            this._pendingUpdates.splice(updateIdx, 1);
        }
    }
    /**
     * Schedule a revert of all optimistic updates on the next `run()`.
     */
    revertAll() {
        this._pendingBackupRebase = true;
        this._pendingUpdates = this._pendingUpdates.filter((update) => update.kind !== 'optimistic');
    }
    /**
     * Schedule applying a payload to the store on the next `run()`.
     * If provided, this will revert the corresponding optimistic update
     */
    commitPayload(operation, { fieldPayloads, source }, updater, optimisticUpdate) {
        const serverData = {
            kind: 'payload',
            payload: { fieldPayloads, operation, source, updater }
        };
        if (optimisticUpdate) {
            const updateIdx = findUpdaterIdx(this._pendingUpdates, optimisticUpdate);
            if (updateIdx !== -1) {
                this._pendingBackupRebase = true;
                this._pendingUpdates.splice(updateIdx, 1, serverData);
                return;
            }
        }
        this._pendingUpdates.push(serverData);
    }
    commitRelayPayload({ fieldPayloads, source }) {
        this._pendingBackupRebase = true;
        this._pendingUpdates.push({
            kind: 'payload',
            payload: { fieldPayloads, operation: null, source, updater: null }
        });
    }
    /**
     * Schedule an updater to mutate the store on the next `run()` typically to
     * update client schema fields.
     */
    commitUpdate(updater) {
        this._pendingUpdates.push({
            kind: 'client',
            updater
        });
    }
    /**
     * Schedule a publish to the store from the provided source on the next
     * `run()`. As an example, to update the store with substituted fields that
     * are missing in the store.
     */
    commitSource(source) {
        this._pendingUpdates.push({ kind: 'source', source });
    }
    /**
     * Execute all queued up operations from the other public methods.
     * There is a single queue for all updates to guarantee linearizability
     */
    run() {
        if (this._pendingBackupRebase) {
            this._currentStoreIdx = 0;
            if (this._backup.size()) {
                this._store.publish(this._backup);
            }
        }
        this._commitPendingUpdates();
        this._applyPendingUpdates();
        this._pendingBackupRebase = false;
        this._currentStoreIdx = this._pendingUpdates.length;
        return this._store.notify();
    }
    _applyPendingUpdates() {
        if (this._currentStoreIdx < this._pendingUpdates.length) {
            const updates = this._pendingUpdates.slice(this._currentStoreIdx);
            this._handleUpdates(updates);
            if (!this._gcHold) {
                this._gcHold = this._store.holdGC();
            }
        }
        else if (this._gcHold && this._pendingUpdates.length === 0) {
            this._gcHold.dispose();
            this._gcHold = null;
        }
    }
    _commitPendingUpdates() {
        const firstOptimisticIdx = this._pendingUpdates.findIndex(({ kind }) => kind === 'optimistic');
        const endIdx = firstOptimisticIdx === -1 ? this._pendingUpdates.length : firstOptimisticIdx;
        if (endIdx > 0) {
            const updatesToCommit = this._pendingUpdates.splice(0, endIdx);
            this._handleUpdates(updatesToCommit, true);
            this._backup.clear();
        }
    }
    _handleUpdates(updates, isCommit) {
        const sink = RelayRecordSource_1.default.create();
        const mutator = new RelayRecordSourceMutator_1.default(this._store.getSource(), sink, isCommit ? undefined : this._backup);
        const store = new RelayRecordSourceProxy_1.default(mutator, this._getDataID, this._handlerProvider);
        for (let ii = 0; ii < updates.length; ii++) {
            const update = updates[ii];
            switch (update.kind) {
                case 'client':
                    ErrorUtils_1.default.applyWithGuard(update.updater, null, [store], null, 'LinearPublishQueue:applyUpdates');
                    break;
                case 'optimistic':
                    applyOptimisticUpdate(update.updater, store, this._getDataID);
                    break;
                case 'payload':
                    applyServerPayloadUpdate(update.payload, store);
                    break;
                case 'source':
                    store.publishSource(update.source);
                    break;
            }
        }
        this._store.publish(sink);
    }
}
function applyOptimisticUpdate(optimisticUpdate, store, getDataID) {
    if (optimisticUpdate.operation) {
        const { selectorStoreUpdater, operation, response } = optimisticUpdate;
        if (response) {
            const { source, fieldPayloads } = normalizeRelayPayload_1.default(operation.root, response, null, {
                getDataID
            });
            store.publishSource(source, fieldPayloads);
            if (selectorStoreUpdater) {
                const selectorData = lookupSelector(source, operation.fragment, operation);
                const selectorStore = new RelayRecordSourceSelectorProxy_1.default(store, operation.fragment);
                ErrorUtils_1.default.applyWithGuard(selectorStoreUpdater, null, [selectorStore, selectorData], null, 'LinearPublishQueue:applyUpdates');
            }
        }
        else {
            const selectorStore = new RelayRecordSourceSelectorProxy_1.default(store, operation.fragment);
            ErrorUtils_1.default.applyWithGuard(selectorStoreUpdater, null, [selectorStore], null, 'LinearPublishQueue:applyUpdates');
        }
    }
    else if (optimisticUpdate.storeUpdater) {
        const { storeUpdater } = optimisticUpdate;
        ErrorUtils_1.default.applyWithGuard(storeUpdater, null, [store], null, 'LinearPublishQueue:applyUpdates');
    }
    else {
        const { source, fieldPayloads } = optimisticUpdate;
        store.publishSource(source, fieldPayloads);
    }
}
function applyServerPayloadUpdate(payload, store) {
    const { fieldPayloads, operation, source, updater } = payload;
    store.publishSource(source, fieldPayloads);
    if (updater) {
        const selector = operation && operation.fragment;
        invariant_1.default(selector != null, 'RelayModernEnvironment: Expected a selector to be provided with updater function.');
        const selectorData = lookupSelector(source, selector, operation);
        const selectorStore = new RelayRecordSourceSelectorProxy_1.default(store, selector);
        updater(selectorStore, selectorData);
    }
}
function findUpdaterIdx(updates, updater) {
    return updates.findIndex((update) => update.updater === updater);
}
function lookupSelector(source, selector, owner) {
    return RelayReader_1.default.read(source, selector, owner).data;
}
exports.default = LinearPublishQueue;
//# sourceMappingURL=index.js.map