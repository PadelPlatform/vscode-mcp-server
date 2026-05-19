import express from "express";
import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from 'http';
import { Request, Response } from 'express';
import { registerFileTools, FileListingCallback } from './tools/file-tools';
import { registerEditTools } from './tools/edit-tools';
import { registerShellTools } from './tools/shell-tools';
import { registerDiagnosticsTools } from './tools/diagnostics-tools';
import { registerSymbolTools } from './tools/symbol-tools';
import { logger } from './utils/logger';

export interface ToolConfiguration {
    file: boolean;
    edit: boolean;
    shell: boolean;
    diagnostics: boolean;
    symbol: boolean;
}

export class MCPServer {
    private server: McpServer;
    private transport: StreamableHTTPServerTransport;
    private app: express.Application;
    private httpServer?: Server;
    private port: number;
    private host: string;
    private fileListingCallback?: FileListingCallback;
    private terminal?: vscode.Terminal;
    private toolConfig: ToolConfiguration;
    // PATCH (pp dev open multi-window): workspace info + per-port discovery file path
    private workspaceInfo: { name: string; path: string } | null;
    private _discoveryFile?: string;

    public setFileListingCallback(callback: FileListingCallback) {
        this.fileListingCallback = callback;
    }

    constructor(port: number = 3000, host: string = '127.0.0.1', terminal?: vscode.Terminal, toolConfig?: ToolConfiguration, workspaceInfo?: { name: string; path: string } | null) {
        this.port = port;
        this.host = host;
        this.terminal = terminal;
        this.workspaceInfo = workspaceInfo || null;
        this.toolConfig = toolConfig || {
            file: true,
            edit: true,
            shell: true,
            diagnostics: true,
            symbol: true
        };
        this.app = express();
        this.app.use(express.json());

        // Initialize MCP Server
        this.server = new McpServer({
            name: "vscode-mcp-server",
            version: "1.0.0",
        }, {
            capabilities: {
                logging: {},
                tools: {
                    listChanged: false
                }
            }
        });

        // Initialize transport
        this.transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        // Note: setupTools() is no longer called here
        this.setupRoutes();
        this.setupEventHandlers();
    }
    
    public setupTools(): void {
        // Register tools from the tools module based on configuration
        if (this.fileListingCallback) {
            logger.info(`Setting up MCP tools with configuration: ${JSON.stringify(this.toolConfig)}`);
            
            // Register file tools if enabled
            if (this.toolConfig.file) {
                registerFileTools(this.server, this.fileListingCallback);
                logger.info('MCP file tools registered successfully');
            } else {
                logger.info('MCP file tools disabled by configuration');
            }
            
            // Register edit tools if enabled
            if (this.toolConfig.edit) {
                registerEditTools(this.server);
                logger.info('MCP edit tools registered successfully');
            } else {
                logger.info('MCP edit tools disabled by configuration');
            }
            
            // Register shell tools if enabled
            if (this.toolConfig.shell) {
                registerShellTools(this.server, this.terminal);
                logger.info('MCP shell tools registered successfully');
            } else {
                logger.info('MCP shell tools disabled by configuration');
            }
            
            // Register diagnostics tools if enabled
            if (this.toolConfig.diagnostics) {
                registerDiagnosticsTools(this.server);
                logger.info('MCP diagnostics tools registered successfully');
            } else {
                logger.info('MCP diagnostics tools disabled by configuration');
            }
            
            // Register symbol tools if enabled
            if (this.toolConfig.symbol) {
                registerSymbolTools(this.server);
                logger.info('MCP symbol tools registered successfully');
            } else {
                logger.info('MCP symbol tools disabled by configuration');
            }
        } else {
            logger.warn('File listing callback not set during tools setup');
        }
    }

    private setupRoutes(): void {
        // Handle POST requests for client-to-server communication
        this.app.post('/mcp', async (req, res) => {
            logger.info(`Request received: ${req.method} ${req.url}`);
            try {
                await this.transport.handleRequest(req, res, req.body);
            } catch (error) {
                logger.error(`Error handling MCP request: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
            }
        });

        // Handle SSE endpoint for server-to-client streaming
        this.app.get('/mcp/sse', async (req, res) => {
            logger.info('Received SSE connection request');
            try {
                await this.transport.handleRequest(req, res, undefined);
            } catch (error) {
                logger.error(`Error handling SSE request: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
            }
        });

        // Handle unsupported methods
        this.app.get('/mcp', async (req, res) => {
            logger.info('Received GET MCP request');
            res.writeHead(405).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Method not allowed."
                },
                id: null
            }));
        });

        this.app.delete('/mcp', async (req, res) => {
            logger.info('Received DELETE MCP request');
            res.writeHead(405).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Method not allowed."
                },
                id: null
            }));
        });

        // Handle OPTIONS requests for CORS
        this.app.options('/mcp', (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
            res.status(204).end();
        });
    }

    private setupEventHandlers(): void {
        // Log HTTP server events
        if (this.httpServer) {
            this.httpServer.on('error', (error: Error) => {
                logger.error(`[Server] HTTP Server Error: ${error.message}`);
            });

            this.httpServer.on('listening', () => {
                logger.info(`[Server] HTTP Server ready`);
            });

            this.httpServer.on('close', () => {
                logger.info(`[Server] HTTP Server closed`);
            });
        }
    }

    public async start(): Promise<void> {
        try {
            logger.info('[MCPServer.start] Starting MCP server');
            const startTime = Date.now();

            // Connect transport before starting server
            logger.info('[MCPServer.start] Connecting transport');
            const transportConnectStart = Date.now();
            await this.server.connect(this.transport);
            const transportConnectTime = Date.now() - transportConnectStart;
            logger.info(`[MCPServer.start] Transport connected (took ${transportConnectTime}ms)`);

            // Start HTTP server
            logger.info('[MCPServer.start] Starting HTTP server');
            const httpServerStartTime = Date.now();

            // PATCH (pp dev open multi-window): retry the next port on EADDRINUSE so each
            // VS Code window can host its own MCP server. Discovery file written after bind
            // lets external tools (pp dev open) map workspace -> port without convention.
            const maxAttempts = 10;
            const basePort = this.port;
            return new Promise<void>((resolve, reject) => {
                const tryListen = (attempt: number) => {
                    if (attempt >= maxAttempts) {
                        reject(new Error(`MCP server failed to bind any port in [${basePort}, ${basePort + maxAttempts - 1}]`));
                        return;
                    }
                    const candidatePort = basePort + attempt;
                    const httpServer = this.app.listen(candidatePort, this.host);
                    const onError = (err: NodeJS.ErrnoException) => {
                        if (err && err.code === 'EADDRINUSE') {
                            logger.info(`[MCPServer.start] Port ${candidatePort} in use; trying ${candidatePort + 1}`);
                            tryListen(attempt + 1);
                        } else {
                            reject(err);
                        }
                    };
                    httpServer.once('error', onError);
                    httpServer.once('listening', () => {
                        httpServer.removeListener('error', onError);
                        this.httpServer = httpServer;
                        this.port = candidatePort;
                        const httpStartTime = Date.now() - httpServerStartTime;
                        logger.info(`[MCPServer.start] HTTP Server started (took ${httpStartTime}ms)`);
                        logger.info(`MCP Server listening on ${this.host}:${this.port}`);
                        try {
                            const fs = require('fs');
                            const os = require('os');
                            const path = require('path');
                            const dir = path.join(os.tmpdir(), 'vscode-mcp-server');
                            fs.mkdirSync(dir, { recursive: true });
                            this._discoveryFile = path.join(dir, `${this.port}.json`);
                            fs.writeFileSync(this._discoveryFile, JSON.stringify({
                                port: this.port,
                                pid: process.pid,
                                workspaceName: this.workspaceInfo ? this.workspaceInfo.name : null,
                                workspacePath: this.workspaceInfo ? this.workspaceInfo.path : null,
                                startTime: new Date().toISOString(),
                            }, null, 2));
                            logger.info(`[MCPServer.start] Wrote discovery file: ${this._discoveryFile}`);
                        } catch (e) {
                            logger.warn(`[MCPServer.start] Failed to write discovery file: ${e instanceof Error ? e.message : String(e)}`);
                        }
                        const totalTime = Date.now() - startTime;
                        logger.info(`[MCPServer.start] Server startup complete (total: ${totalTime}ms)`);
                        resolve();
                    });
                };
                tryListen(0);
            });
        } catch (error) {
            logger.error(`[MCPServer.start] Failed to start MCP Server: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    public async stop(forceTimeout: number = 5000): Promise<void> {
        logger.info('[MCPServer.stop] Starting server shutdown process');
        const stopStartTime = Date.now();

        // PATCH (pp dev open multi-window): remove discovery file (best-effort)
        try {
            if (this._discoveryFile) {
                const fs = require('fs');
                if (fs.existsSync(this._discoveryFile)) { fs.unlinkSync(this._discoveryFile); }
                logger.info(`[MCPServer.stop] Removed discovery file: ${this._discoveryFile}`);
                this._discoveryFile = undefined;
            }
        } catch (e) {
            logger.warn(`[MCPServer.stop] Failed to remove discovery file: ${e instanceof Error ? e.message : String(e)}`);
        }

        try {
            // Close HTTP server with timeout
            if (this.httpServer) {
                logger.info('[MCPServer.stop] Closing HTTP server (with timeout)');
                const httpServerCloseStart = Date.now();
                
                await Promise.race([
                    // Normal close operation
                    new Promise<void>((resolve, reject) => {
                        this.httpServer!.close((err) => {
                            const httpCloseTime = Date.now() - httpServerCloseStart;
                            if (err) {
                                logger.error(`[MCPServer.stop] HTTP server closed with error: ${err.message} (took ${httpCloseTime}ms)`);
                                reject(err);
                            } else {
                                logger.info(`[MCPServer.stop] HTTP server closed successfully (took ${httpCloseTime}ms)`);
                                resolve();
                            }
                        });
                    }),
                    
                    // Timeout fallback
                    new Promise<void>((resolve) => {
                        setTimeout(() => {
                            logger.warn(`[MCPServer.stop] HTTP server close timed out after ${forceTimeout}ms - forcing close`);
                            // We resolve anyway to continue with the shutdown process
                            resolve();
                        }, forceTimeout);
                    })
                ]);
            }

            // Rest of the shutdown process...
            logger.info('[MCPServer.stop] Closing transport');
            const transportCloseStart = Date.now();
            await this.transport.close();
            const transportCloseTime = Date.now() - transportCloseStart;
            logger.info(`[MCPServer.stop] Transport closed (took ${transportCloseTime}ms)`);
            
            logger.info('[MCPServer.stop] Closing MCP server');
            const serverCloseStart = Date.now();
            await this.server.close();
            const serverCloseTime = Date.now() - serverCloseStart;
            logger.info(`[MCPServer.stop] MCP server closed (took ${serverCloseTime}ms)`);
            
            const totalStopTime = Date.now() - stopStartTime;
            logger.info(`[MCPServer.stop] MCP Server shutdown complete (total: ${totalStopTime}ms)`);
        } catch (error) {
            logger.error(`[MCPServer.stop] Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}