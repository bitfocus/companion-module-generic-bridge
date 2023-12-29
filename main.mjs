/*
**  Generic Bridge for Reflecting States in Bitfocus Companion
**  Copyright (c) 2023 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under MIT <https://spdx.org/licenses/MIT>
*/
/*  load external requirements  */
import CompanionModule from "@companion-module/base";
import { WebSocket, WebSocketServer } from "ws";
import ObjectPath from "object-path";
/*  load external requirements (special case for module with import problems)  */
import ReconnectingWebSocketNS from "reconnecting";
const ReconnectingWebSocket = ReconnectingWebSocketNS.default;
const ModuleConfigDefault = {
    role: "client",
    addr: "127.0.0.1",
    port: 7766,
    debug: false
};
/*  define Companion Module class  */
class Module extends CompanionModule.InstanceBase {
    /*  class construction  */
    constructor(internal) {
        super(internal);
        /*  internal state  */
        this.config = ModuleConfigDefault;
        this.actions = new Map();
        this.feedbacks = new Map();
        this.server = null;
        this.client = null;
    }
    /*  Companion Module API: declare module configuration fields  */
    getConfigFields() {
        return [{
                type: "static-text",
                id: "info",
                width: 12,
                label: "Information",
                value: "This exposes a Bridge service for reflecting Companion states. " +
                    "It can be used to bridge between two Companion instances (client/server) or " +
                    "between a Companion instance (server) and a custom application. " +
                    "It provides either a WebSocket server (listening) or WebSocket client (connecting) " +
                    "based service. For bridging states over the established WebSocket connection, " +
                    "use Companion Triggers to send states and Companion Feedbacks to receive states."
            }, {
                type: "dropdown",
                id: "role",
                label: "Bridge WebSocket Communication Role",
                tooltip: "Set the local communication role of the Bridge, either WebSocket Server or WebSocket Client",
                choices: [
                    { id: "client", label: "WebSocket Client (connecting)" },
                    { id: "server", label: "WebSocket Server (listening)" }
                ],
                default: ModuleConfigDefault.role,
                width: 12
            }, {
                type: "textinput",
                id: "addr",
                label: "Bridge WebSocket IP Address",
                tooltip: "The IP address of the WebSocket endpoint of the Bridge, " +
                    "local for role Server, remote for role Client " +
                    "(use \"0.0.0.0\" for all addresses of the underlying system for role Server)",
                width: 12,
                default: ModuleConfigDefault.addr,
                regex: "/.+/",
                required: true
            }, {
                type: "number",
                id: "port",
                label: "Bridge WebSocket TCP Port",
                tooltip: "The TCP port of the WebSocket endpoint of the Bridge, " +
                    "local for role Server, remote for role Client " +
                    "(use a port which is still unused on the underlying system for role Server)",
                width: 12,
                default: ModuleConfigDefault.port,
                min: 0,
                max: 65535,
                required: true
            }, {
                type: "checkbox",
                id: "debug",
                label: "Log Debug Information",
                tooltip: "Log debug information to trace internal processing",
                default: ModuleConfigDefault.debug,
                width: 12
            }];
    }
    /*  Companion Module API: initialize module  */
    async init(config) {
        if (this.config.debug)
            this.log("info", "[Bridge]: module: initialize");
        /*  remember configuration  */
        this.config = config;
        /*  sanity check configuration  */
        if (!this.config.addr || !this.config.port) {
            this.updateStatus(CompanionModule.InstanceStatus.BadConfig, "either Address or Port not set");
            return;
        }
        /*  start services  */
        await this.clientStart();
        await this.serverStart();
        /*  declare action  */
        await this.actionDeclare();
        /*  declare feedbacks  */
        await this.feedbackDeclare();
        await this.feedbackUpdateVariables();
        /*  indicate state  */
        this.updateStatus(CompanionModule.InstanceStatus.Ok);
    }
    /*  Companion Module API: destroy module  */
    async destroy() {
        if (this.config.debug)
            this.log("info", "[Bridge]: module: destroy");
        /*  stop services  */
        await this.clientStop();
        await this.serverStop();
    }
    /*  Companion Module API: update configuration  */
    async configUpdated(config) {
        if (this.config.debug)
            this.log("info", "[Bridge]: module: update configuration");
        /*  remember configuration  */
        this.config = config;
        /*  stop services  */
        await this.clientStop();
        await this.serverStop();
        /*  start services  */
        await this.serverStart();
        await this.clientStart();
        /*  indicate state  */
        this.updateStatus(CompanionModule.InstanceStatus.Ok);
    }
    /*  internal helper function for server starting  */
    async serverStart() {
        if (this.config.role !== "server")
            return;
        this.log("info", `[Bridge]: server: listener initiated (local: ${this.config.addr}:${this.config.port})`);
        this.updateStatus(CompanionModule.InstanceStatus.Connecting);
        this.server = new WebSocketServer({
            host: this.config.addr,
            port: this.config.port
        });
        this.server.on("connection", (ws, req) => {
            /*  determine client  */
            const remoteAddr = req?.socket?.remoteAddress ?? "0.0.0.0";
            const remotePort = req?.socket?.remotePort ?? "0";
            const remote = `${remoteAddr}:${remotePort}`;
            this.log("info", `[Bridge]: server: connection received (client: ${remote})`);
            /*  react on events  */
            ws.on("message", async (data) => {
                const msg = data.toString();
                if (this.config.debug)
                    this.log("info", `[Bridge]: server: received message: ${msg}`);
                const state = await this.receiveState(msg);
                await this.sendState(JSON.stringify(state), ws);
            });
            ws.on("close", (ev) => {
                this.log("info", `[Bridge]: server: connection closed (code: ${ev.code})`);
            });
            ws.on("error", (ev) => {
                this.log("error", `[Bridge]: server: connection error (reason: ${ev.message})`);
            });
            /*  initially emit all states  */
            this.actionEmitState();
        });
        this.server.on("listening", () => {
            this.log("info", "[Bridge]: server: listener established");
        });
        this.server.on("close", (ev) => {
            this.log("info", `[Bridge]: server: listener closed (code: ${ev.code})`);
        });
        this.server.on("error", (ev) => {
            this.log("error", `[Bridge]: server: listener error (reason: ${ev.message})`);
        });
    }
    /*  internal helper function for server stopping  */
    async serverStop() {
        if (this.config.role !== "server")
            return;
        this.log("info", "[Bridge]: service: stop");
        if (this.server !== null) {
            try {
                this.log("info", "[Bridge]: server: listener closing");
                this.server.close();
            }
            catch (err) {
            }
            this.server = null;
        }
    }
    /*  internal helper function for client starting  */
    async clientStart() {
        if (this.config.role !== "client")
            return;
        this.log("info", `[Bridge]: client: connection initiated (remote: ${this.config.addr}:${this.config.port})`);
        this.client = new ReconnectingWebSocketNS(`ws://${this.config.addr}:${this.config.port}`, [], {
            WebSocket,
            reconnectionDelayGrowFactor: 1.3,
            maxReconnectionDelay: 4000,
            minReconnectionDelay: 1000,
            connectionTimeout: 4000,
            minUptime: 5000
        });
        this.client.addEventListener("open", ( /* ev */) => {
            this.log("info", "[Bridge]: client: connection established");
        });
        this.client.addEventListener("close", (ev) => {
            this.log("error", `[Bridge]: client: connection closed (code: ${ev.code})`);
        });
        this.client.addEventListener("error", (ev) => {
            this.log("error", `[Bridge]: client: connection error (reason: ${ev.message})`);
        });
        this.client.addEventListener("message", (ev) => {
            const msg = ev.data.toString();
            if (this.config.debug)
                this.log("info", `[Bridge]: client: received message: ${msg}`);
            this.receiveState(msg);
        });
    }
    /*  internal helper function for client stopping  */
    async clientStop() {
        if (this.config.role !== "client")
            return;
        this.log("info", "[Bridge]: client: stop");
        if (this.client !== null) {
            try {
                this.log("info", "[Bridge]: client: connection closing");
                this.client.close();
            }
            catch (err) {
            }
            this.client = null;
        }
    }
    /*  helper function for declaring actions  */
    async actionDeclare() {
        this.setActionDefinitions({
            sendBridgeStateJSON: {
                name: "Send Bridge State (JSON)",
                description: "Send a bridge state as a JSON key/value pair",
                options: [{
                        id: "key",
                        type: "textinput",
                        label: "Bridge State Key [JSON Field Name]",
                        regex: "/^[-a-zA-Z0-9_]+$/",
                        default: "foo"
                    }, {
                        id: "expr",
                        type: "textinput",
                        label: "Bridge State Value [JSON Field Value]",
                        default: "$(internal:custom_foo)"
                    }],
                subscribe: async (action /*, context */) => {
                    const id = action.id;
                    const key = action.options.key;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: subscribe: JSON state: id: "${id}", key: "${key}", expr: "${expr}"`);
                    this.actions.set(id, { type: "json", key, expr });
                },
                unsubscribe: async (action /*, context */) => {
                    const id = action.id;
                    const key = action.options.key;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: unsubscribe: JSON state: id: "${id}", key: "${key}", expr: "${expr}"`);
                    this.actions.delete(id);
                },
                callback: async (action) => {
                    const id = action.id;
                    const key = action.options.key;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: send: JSON state: id: "${id}", key: "${key}", expr: "${expr}"`);
                    this.actionEmitState(id);
                }
            },
            sendBridgeStateRAW: {
                name: "Send Bridge State (Raw)",
                description: "Send a bridge state as a raw string",
                options: [{
                        id: "expr",
                        type: "textinput",
                        label: "Bridge State String",
                        default: "foo=$(internal:custom_foo)"
                    }],
                subscribe: async (action /*, context */) => {
                    const id = action.id;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: subscribe: RAW state: id: "${id}", expr: "${expr}"`);
                    this.actions.set(id, { type: "raw", expr });
                },
                unsubscribe: async (action /*, context */) => {
                    const id = action.id;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: unsubscribe: RAW state: id: "${id}", expr: "${expr}"`);
                    this.actions.delete(id);
                },
                callback: async (action) => {
                    const id = action.id;
                    const expr = action.options.expr;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: action: send: RAW state: id: "${id}", expr: "${expr}"`);
                    this.actionEmitState(id);
                }
            }
        });
    }
    /*  internal helper function for emitting state  */
    async actionEmitState(id) {
        if (!id) {
            /*  emit all actions  */
            for (const id of Object.keys(this.actions))
                await this.actionEmitState(id);
        }
        else if (this.actions.has(id)) {
            /*  emit a single actions expression  */
            const action = this.actions.get(id);
            let state = await this.parseVariablesInString(action.expr);
            if (action.type === "json")
                state = JSON.stringify({ [action.key]: state }) + "\r\n";
            else if (action.type === "raw")
                state = state.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
            this.sendState(state);
        }
    }
    /*  internal helper function for sending state  */
    async sendState(msg, sender = null) {
        if (this.server !== null) {
            this.server.clients.forEach((ws) => {
                if (sender !== null && ws === sender)
                    return;
                if (this.config.debug)
                    this.log("info", `[Bridge]: server: send state: message: ${msg}`);
                ws.send(msg);
            });
        }
        else if (this.client !== null) {
            if (this.config.debug)
                this.log("info", `[Bridge]: client: send state: message: ${msg}`);
            this.client.send(msg);
        }
    }
    /*  helper function for declaring feedbacks  */
    async feedbackDeclare() {
        this.setFeedbackDefinitions({
            receiveBridgeStateJSON: {
                type: "advanced",
                name: "Receive Bridge State (JSON)",
                description: "Receive a bridge state as a JSON string",
                options: [{
                        id: "key",
                        type: "textinput",
                        label: "Bridge State Key [JSON Path]",
                        regex: "/.+/",
                        default: "foo"
                    }, {
                        id: "def",
                        type: "textinput",
                        label: "Bridge State Default [Variable Value]",
                        default: ""
                    }, {
                        id: "name",
                        type: "textinput",
                        label: "Bridge State Name [Variable Name]",
                        regex: "/^[-a-zA-Z0-9_]+$/",
                        default: "foo"
                    }],
                subscribe: async (feedback) => {
                    const id = feedback.id;
                    const key = feedback.options.key;
                    const def = feedback.options.def;
                    const name = feedback.options.name;
                    this.feedbacks.set(id, { type: "json", key, def, name });
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: subscribe: JSON state: key: "${key}", def: "${def}", name: "${name}"`);
                    this.feedbackUpdateVariables(id);
                },
                unsubscribe: async (feedback) => {
                    const id = feedback.id;
                    const key = feedback.options.key;
                    const def = feedback.options.def;
                    const name = feedback.options.name;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: unsubscribe: JSON state: key: "${key}", def: "${def}", name: "${name}"`);
                    this.feedbacks.delete(id);
                },
                callback: () => {
                    return {};
                }
            },
            receiveBridgeStateRAW: {
                type: "advanced",
                name: "Receive Bridge State (Raw)",
                description: "Receive a bridge state as a raw string",
                options: [{
                        id: "regex",
                        type: "textinput",
                        label: "Bridge State Key [Regex]",
                        regex: "/^([-a-zA-Z0-9_]+)=(.+)$/",
                        default: "foo"
                    }, {
                        id: "def",
                        type: "textinput",
                        label: "Bridge State Default [Variable Value]",
                        default: ""
                    }, {
                        id: "name",
                        type: "textinput",
                        label: "Bridge State Key [Variable Name]",
                        regex: "/^[-a-zA-Z0-9_]+$/",
                        default: "foo"
                    }],
                subscribe: async (feedback) => {
                    const id = feedback.id;
                    const regex = feedback.options.regex;
                    const def = feedback.options.def;
                    const name = feedback.options.name;
                    this.feedbacks.set(id, { type: "raw", regex, def, name });
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: subscribe: RAW state: regex: "${regex}", def: "${def}", name: "${name}"`);
                    this.feedbackUpdateVariables(id);
                },
                unsubscribe: async (feedback) => {
                    const id = feedback.id;
                    const regex = feedback.options.regex;
                    const def = feedback.options.def;
                    const name = feedback.options.name;
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: unsubscribe: RAW state: regex: "${regex}", def: "${def}", name: "${name}"`);
                    this.feedbacks.delete(id);
                },
                callback: () => {
                    return {};
                }
            }
        });
    }
    /*  helper function for updating own Companion variables  */
    async feedbackUpdateVariables(callerId = null) {
        const varDefs = [];
        const varVals = {};
        this.feedbacks.forEach((feedback, id) => {
            if (this.config.debug)
                this.log("info", `[Bridge]: feedback: define variable: name: "${feedback.name}"`);
            varDefs.push({ variableId: feedback.name, name: feedback.name });
            if (callerId === null || callerId === id) {
                if (this.config.debug)
                    this.log("info", `[Bridge]: feedback: reset variable: name: "${feedback.name}", value: "${feedback.def}"`);
                varVals[feedback.name] = feedback.def;
            }
        });
        this.setVariableDefinitions(varDefs);
        this.setVariableValues(varVals);
    }
    /*  internal helper function for sending state  */
    async receiveState(msg) {
        let obj = null;
        try {
            obj = JSON.parse(msg);
        }
        catch (err) {
            obj = {};
        }
        this.feedbacks.forEach((feedback) => {
            if (feedback.type === "json") {
                if (ObjectPath.has(obj, feedback.key)) {
                    const value = ObjectPath.get(obj, feedback.key);
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: set variable: name: "${feedback.name}", value: "${value}"`);
                    this.setVariableValues({ [feedback.name]: value });
                }
            }
            else if (feedback.type === "raw") {
                const m = msg.match(feedback.regex);
                if (m !== null && m[1] !== undefined) {
                    const value = m[1];
                    if (this.config.debug)
                        this.log("info", `[Bridge]: feedback: set variable: name: "${feedback.name}", value: "${value}"`);
                    this.setVariableValues({ [feedback.name]: value });
                }
            }
        });
        return obj;
    }
}
/*  hook into Companion  */
CompanionModule.runEntrypoint(Module, []);
