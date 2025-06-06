'use strict';
self.inputPort = null;
self.jobQueue = [];
self.jobWorkers = [];
self.sentBlobs = [];
self.sentBuffers = [];
self.importedScripts = [];
self.lastBroadcasts = new Map;
class JobWorker {
    constructor(port, number) {
        this._port = port;
        this._number = number;
        this._isReady = false;
        this._isBusy = false;
        this._port.onmessage = e => this._OnMessage(e.data)
    }
    ImportScripts(scripts) {
        this._port.postMessage({
            "type": "_import_scripts",
            "scripts": scripts
        })
    }
    SendBlob(blob, id) {
        this._port.postMessage({
            "type": "_send_blob",
            "blob": blob,
            "id": id
        })
    }
    SendBuffer(buffer, id) {
        this._port.postMessage({
            "type": "_send_buffer",
            "buffer": buffer,
            "id": id
        })
    }
    SendJob(job) {
        if (this._isBusy || !this._isReady)
            throw new Error("cannot take job");
        this._isBusy = true;
        this._port.postMessage(job, job["transferables"])
    }
    _InitBroadcast(job) {
        this._port.postMessage(job, job["transferables"])
    }
    SendReady() {
        this._port.postMessage({
            "type": "_ready"
        })
    }
    IsReady() {
        return this._isReady
    }
    _OnReady() {
        this._isReady = true;
        this.MaybeStartNextJob()
    }
    IsBusy() {
        return this._isBusy
    }
    GetNumber() {
        return this._number
    }
    _OnMessage(msg) {
        const type = msg["type"];
        switch (type) {
        case "ready":
            this._OnReady();
            return;
        case "done":
            this._OnJobDone();
            return;
        default:
            console.error("unknown message from worker '" + type + "'");
            return
        }
    }
    _OnJobDone() {
        this._isBusy = false;
        this.MaybeStartNextJob()
    }
    MaybeStartNextJob() {
        if (this._isBusy || !this._isReady)
            return;
        const i = this._FindAvailableJob();
        if (i === -1)
            return;
        const job = self.jobQueue[i];
        const isBroadcast = job["isBroadcast"];
        if (isBroadcast) {
            job["doneFlags"][this._number] = true;
            if (job["doneFlags"].every(x => x))
                self.jobQueue.splice(i, 1)
        } else
            self.jobQueue.splice(i, 1);
        this.SendJob(job)
    }
    _FindAvailableJob() {
        for (let i = 0, len = self.jobQueue.length; i < len; ++i) {
            const job = self.jobQueue[i];
            if (typeof job["maxWorkerNum"] === "number" && this._number >= job["maxWorkerNum"])
                continue;
            if (!job["isBroadcast"] || this._number < job["doneFlags"].length && !job["doneFlags"][this._number])
                return i
        }
        return -1
    }
}
let number = 0;
function AddJobWorker(port) {
    const jobWorker = new JobWorker(port,number++);
    self.jobWorkers.push(jobWorker);
    for (const [blob,id] of self.sentBlobs)
        jobWorker.SendBlob(blob, id);
    for (const [buffer,id] of self.sentBuffers)
        jobWorker.SendBuffer(buffer, id);
    for (const scripts of self.importedScripts)
        jobWorker.ImportScripts(scripts);
    for (const broadcastJob of self.lastBroadcasts.values())
        jobWorker._InitBroadcast(broadcastJob);
    jobWorker.SendReady()
}
function CancelJob(jobId) {
    for (let i = 0, len = self.jobQueue.length; i < len; ++i)
        if (self.jobQueue[i].jobId === jobId) {
            self.jobQueue.splice(i, 1);
            return
        }
}
self.addEventListener("message", e => {
    const msg = e.data;
    const type = msg["type"];
    if (type === "_init") {
        self.inputPort = msg["in-port"];
        self.inputPort.onmessage = OnInputPortMessage
    } else if (type === "_addJobWorker")
        AddJobWorker(msg["port"])
}
);
function OnInputPortMessage(e) {
    const msg = e.data;
    const type = msg["type"];
    if (type === "_cancel") {
        CancelJob(msg.jobId);
        return
    } else if (type === "_import_scripts") {
        const scripts = msg["scripts"];
        for (const w of self.jobWorkers)
            w.ImportScripts(scripts);
        self.importedScripts.push(scripts);
        return
    } else if (type === "_send_blob") {
        const blob = msg["blob"];
        const id = msg["id"];
        for (const w of self.jobWorkers)
            w.SendBlob(blob, id);
        self.sentBlobs.push([blob, id]);
        return
    } else if (type === "_send_buffer") {
        const buffer = msg["buffer"];
        const id = msg["id"];
        for (const w of self.jobWorkers)
            w.SendBuffer(buffer, id);
        self.sentBuffers.push([buffer, id]);
        return
    } else if (type === "_no_more_workers") {
        self.sentBlobs.length = 0;
        self.sentBuffers.length = 0;
        self.importedScripts.length = 0;
        self.lastBroadcasts.clear();
        return
    }
    self.jobQueue.push(msg);
    if (msg["isBroadcast"]) {
        const maxWorkerNum = msg["maxWorkerNum"];
        const curWorkerCount = self.jobWorkers.length;
        const useWorkerCount = typeof maxWorkerNum === "number" ? Math.min(maxWorkerNum, curWorkerCount) : curWorkerCount;
        msg["doneFlags"] = (new Array(useWorkerCount)).fill(false);
        msg["transferables"] = [];
        const broadcastKey = msg["params"] && msg["params"]["broadcastKey"] ? msg["params"]["broadcastKey"] : msg["type"];
        self.lastBroadcasts.delete(broadcastKey);
        self.lastBroadcasts.set(broadcastKey, msg)
    }
    for (const w of self.jobWorkers)
        w.MaybeStartNextJob()
}
;