import { Controller, Delete, Get, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { AgentTokenService } from '../agent/agent-token.service.js';
import { ClinicToolsService, TOOL_DESCRIPTIONS, TOOL_INPUTS, type ToolName } from './clinic-tools.service.js';

const READ_ONLY: ToolName[] = ['list_appointment_types', 'check_availability', 'get_my_appointments', 'get_my_outcome'];

/**
 * The MCP server the agent calls. Stateless: every request brings its agent token, is
 * checked here (the agent can't vouch for itself), and gets a fresh server whose tools
 * are bound to that token's patient. Nothing is shared between requests or patients.
 */
@Controller('mcp')
export class McpController {
  constructor(
    private readonly tokens: AgentTokenService,
    private readonly tools: ClinicToolsService,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response) {
    const header = req.headers.authorization ?? '';
    const who = this.tokens.verify(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined);
    if (!who) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: 'UNAUTHENTICATED',
        reasons: [{ code: 'UNAUTHENTICATED', message: 'A valid, unexpired agent token is required.' }],
      });
      return;
    }

    const server = new McpServer({ name: 'eye-clinic', version: '1.0.0' });
    const inputs = await this.tools.inputs();
    for (const name of Object.keys(TOOL_INPUTS) as ToolName[]) {
      server.registerTool(
        name,
        {
          description: TOOL_DESCRIPTIONS[name],
          inputSchema: inputs[name],
          annotations: { readOnlyHint: READ_ONLY.includes(name) },
        },
        async (args: unknown) => {
          const result = await this.tools.call(name, args, who);
          return {
            // The model reads this...
            content: [{ type: 'text' as const, text: JSON.stringify(result.data) }],
            isError: result.isError ?? false,
            // ...and the agent passes cards to the page without showing them to the model.
            ...(result.cards ? { _meta: { cards: result.cards } } : {}),
          };
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** No streams or sessions to open or close in stateless mode. */
  @Get()
  @Delete()
  notAllowed(@Res() res: Response) {
    res.status(HttpStatus.METHOD_NOT_ALLOWED).json({ error: 'METHOD_NOT_ALLOWED' });
  }
}
