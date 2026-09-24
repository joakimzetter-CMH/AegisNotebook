'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal, Sparkles, Play, Folder, File, Code, FileCode, CheckCircle,
  Loader2, RefreshCw, ChevronRight, ChevronDown, Save, Copy, FileDiff,
  Settings, Trash2, Plus, Maximize2, RotateCcw, X, Shield, Bot, Check,
  AlertTriangle, ExternalLink, Cpu, Database
} from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  description: string;
  status: string;
  avatar: string;
}

interface WorkspaceFile {
  name: string;
  path: string;
  isDir: boolean;
  children?: WorkspaceFile[];
}

interface ChatMessage {
  sender: 'user' | 'assistant' | 'system';
  message: string;
  type?: 'status' | 'log' | 'file_edit' | 'done';
  timestamp: string;
}

interface SubAgent {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  description: string;
  source: string;
  systemPrompt: string;
}

interface AgentWorkspaceProps {
  compact?: boolean;
  notebookId?: string;
  className?: string;
}

export default function AgentWorkspace({ compact = false, notebookId, className = '' }: AgentWorkspaceProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [prompt, setPrompt] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [editedFiles, setEditedFiles] = useState<string[]>([]);
  
  // Conversations per agent
  const [chatHistories, setChatHistories] = useState<Record<string, ChatMessage[]>>({
    'antigravity': [],
    'claude': [],
    'skills': [],
    'subagent': [],
    'gemini': [],
    'copilot': [],
    'codex': [],
    'swe': []
  });

  const [currentStatus, setCurrentStatus] = useState<string>('Ready');
  const [activeTab, setActiveTab] = useState<'editor' | 'diff'>('editor');
  const [originalContent, setOriginalContent] = useState<string>('');

  const logsEndRef = useRef<HTMLDivElement>(null);
  const isLoaded = useRef(false);

  // Dynamic Skills & Sub-Agents state
  const [skillsList, setSkillsList] = useState([
    { id: 'regex-search', name: 'Regex Searcher', category: 'Search', description: 'Find content patterns using standard regular expression models.', source: 'skills-hub.ai' },
    { id: 'css-tweaker', name: 'CSS Optimizer', category: 'Styling', description: 'Automatically optimize and clean up Tailwind & CSS attributes.', source: 'skills-hub.ai' },
    { id: 'go-linter', name: 'Go Linter', category: 'Quality', description: 'Format and lint Go workspace files cleanly.', source: 'skills-hub.ai' },
    { id: 'plane-mcp', name: 'Plane MCP Connector', category: 'Project Management', description: 'Connects AI fleet to Plane (https://plane.cortex-lab.xyz) for backlog management, automated bug triage, and sprint tracking.', source: 'plane-mcp-server' }
  ]);

  const [subagentsList, setSubagentsList] = useState<SubAgent[]>([]);
  const [marketplaceSubagents, setMarketplaceSubagents] = useState<SubAgent[]>([]);

  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [showSubagentsModal, setShowSubagentsModal] = useState(false);
  const [modalSubagentTab, setModalSubagentTab] = useState<'browse' | 'create'>('browse');
  const [configuringSubagent, setConfiguringSubagent] = useState<SubAgent | null>(null);
  const [modalCategory, setModalCategory] = useState('All');

  // Custom agent creation states
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRole, setNewAgentRole] = useState('Architecture');
  const [newAgentProvider, setNewAgentProvider] = useState('Claude CLI');
  const [newAgentModel, setNewAgentModel] = useState('Claude 3.5 Sonnet');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');

  // Agent Authentication States
  const [antigravityAuth, setAntigravityAuth] = useState<{ type: 'google' | 'key' | null; user: string | null; token: string | null }>({ type: null, user: null, token: null });
  const [claudeAuth, setClaudeAuth] = useState<{ type: 'session' | 'key' | null; user: string | null; token: string | null; apiKey: string | null }>({ type: null, user: null, token: null, apiKey: null });
  const [geminiAuth, setGeminiAuth] = useState<{ type: 'key' | null; apiKey: string | null }>({ type: null, apiKey: null });
  const [copilotAuth, setCopilotAuth] = useState<{ type: 'token' | null; token: string | null }>({ type: null, token: null });
  const [codexAuth, setCodexAuth] = useState<{ type: 'key' | null; apiKey: string | null }>({ type: null, apiKey: null });
  const [sweAuth, setSweAuth] = useState<{ type: 'configured' | null; githubToken: string | null; llmKey: string | null; llmProvider: string | null }>({ type: null, githubToken: null, llmKey: null, llmProvider: null });
  const [showAuthModal, setShowAuthModal] = useState<'antigravity' | 'claude' | 'gemini' | 'copilot' | 'codex' | 'swe' | null>(null);

  const [tempApiKey, setTempApiKey] = useState('');
  const [tempDevToken, setTempDevToken] = useState('');
  const [tempGithubToken, setTempGithubToken] = useState('');
  const [tempSweProvider, setTempSweProvider] = useState('OpenAI');
  const [tempAuthType, setTempAuthType] = useState<'google' | 'session' | 'key'>('google');

  const [marketplaceSkills, setMarketplaceSkills] = useState<{ id: string; name: string; category: string; description: string; source: string }[]>([]);

  // Load from LocalStorage or defaults
  useEffect(() => {
    const storedActive = localStorage.getItem('cortex_active_subagents');
    const storedMarket = localStorage.getItem('cortex_market_subagents');
    const storedAntiAuth = localStorage.getItem('cortex_anti_auth');
    const storedClaudeAuth = localStorage.getItem('cortex_claude_auth');

    const defaultMarket: SubAgent[] = [
      { id: 'security-audit', name: 'Security Auditor', role: 'Security', provider: 'Claude CLI', model: 'Claude 3.5 Sonnet', description: 'Static vulnerability scanner for dependency trees.', source: 'fleet-registry', systemPrompt: 'Run security checks, dependency audits, and compliance trace logs.' },
      { id: 'pr-reviewer', name: 'PR Reviewer', role: 'Quality Assurance', provider: 'Antigravity CLI', model: 'GPT-4o', description: 'Automates pull request checking and validation pipelines.', source: 'fleet-registry', systemPrompt: 'Check code formatting, syntax errors, and potential runtime panic vectors.' },
      { id: 'optimization-agent', name: 'Performance Specialist', role: 'Optimization', provider: 'Gemini CLI', model: 'Gemini 1.5 Pro', description: 'Analyzes cpu/mem allocations to suggest profile tweaks.', source: 'fleet-registry', systemPrompt: 'Look for CPU hotspots, memory leaks, and inefficient slice allocations.' },
      { id: 'testing-bot', name: 'Testing Agent', role: 'Quality Assurance', provider: 'Antigravity CLI', model: 'Claude 3.5 Sonnet', description: 'Writes comprehensive unit, integration, and mock tests for endpoints.', source: 'fleet-registry', systemPrompt: 'Write robust unit tests in Go or Jest. Ensure full coverage and mock all database calls.' },
      { id: 'docker-expert', name: 'Containerization Expert', role: 'Custom', provider: 'Gemini CLI', model: 'Gemini 1.5 Pro', description: 'Configures optimized multi-stage Dockerfiles, compose, and deploy files.', source: 'fleet-registry', systemPrompt: 'Ensure multi-stage builds are used in Dockerfiles. Minimize image sizes and pin base image tags.' },
      { id: 'database-specialist', name: 'Database Specialist', role: 'Optimization', provider: 'Aider', model: 'GPT-4o', description: 'Generates SQL migrations, schema design, and query optimization plans.', source: 'fleet-registry', systemPrompt: 'Optimize database schemas, write query indexing migrations, and suggest profile tweaks.' },
      { id: 'api-designer', name: 'API Designer', role: 'Architecture', provider: 'Claude CLI', model: 'Claude 3.5 Sonnet', description: 'Designs clean RESTful and gRPC API interfaces with mock payloads.', source: 'fleet-registry', systemPrompt: 'Design RESTful JSON APIs adhering strictly to standards. Draft Swagger/OpenAPI specifications.' },
      { id: 'plane-sync', name: 'Plane Sprint Manager', role: 'Architecture', provider: 'Antigravity CLI', model: 'Claude 3.5 Sonnet', description: 'Synchronizes issues and sprint cycles with self-hosted Plane instance via MCP.', source: 'fleet-registry', systemPrompt: 'Query assigned tasks from Plane via MCP, implement requested changes in private sandbox, update issue status to Done, and post resolution comments.' }
    ];

    if (storedActive) {
      try { setSubagentsList(JSON.parse(storedActive)); } catch {}
    } else {
      setSubagentsList([
        { id: 'refactor-bot', name: 'Refactoring Agent', role: 'Architecture', provider: 'Claude CLI', model: 'Claude 3.5 Sonnet', description: 'Specializes in code modularity and structural enhancement.', source: 'fleet-registry', systemPrompt: 'Focus on clean architecture, DRY principles, and modularizing complex code blocks.' },
        { id: 'doc-writer', name: 'Documentation Agent', role: 'Docs', provider: 'Antigravity CLI', model: 'Gemini 1.5 Pro', description: 'Generates high quality markdown documentation and README guides.', source: 'fleet-registry', systemPrompt: 'Format output with proper markdown headers, tables, and clear API signatures.' }
      ]);
    }

    if (storedMarket) {
      try {
        const parsed = JSON.parse(storedMarket);
        const merged = [...parsed];
        for (const def of defaultMarket) {
          if (!merged.some((m: SubAgent) => m.id === def.id)) {
            merged.push(def);
          }
        }
        setMarketplaceSubagents(merged);
      } catch {
        setMarketplaceSubagents(defaultMarket);
      }
    } else {
      setMarketplaceSubagents(defaultMarket);
    }

    const storedGeminiAuth = localStorage.getItem('cortex_gemini_auth');
    const storedCopilotAuth = localStorage.getItem('cortex_copilot_auth');
    const storedCodexAuth = localStorage.getItem('cortex_codex_auth');
    const storedSweAuth = localStorage.getItem('cortex_swe_auth');
    if (storedGeminiAuth) try { setGeminiAuth(JSON.parse(storedGeminiAuth)); } catch {}
    if (storedCopilotAuth) try { setCopilotAuth(JSON.parse(storedCopilotAuth)); } catch {}
    if (storedCodexAuth) try { setCodexAuth(JSON.parse(storedCodexAuth)); } catch {}
    if (storedSweAuth) try { setSweAuth(JSON.parse(storedSweAuth)); } catch {}

    if (storedAntiAuth) try { setAntigravityAuth(JSON.parse(storedAntiAuth)); } catch {}
    if (storedClaudeAuth) {
      try {
        const parsed = JSON.parse(storedClaudeAuth);
        if (parsed && typeof parsed === 'object') {
          if (!('type' in parsed)) {
            setClaudeAuth({
              type: parsed.apiKey ? 'key' : null,
              user: null,
              token: null,
              apiKey: parsed.apiKey || null
            });
          } else {
            setClaudeAuth(parsed);
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    isLoaded.current = true;
  }, []);

  // Save to LocalStorage whenever state updates
  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_active_subagents', JSON.stringify(subagentsList));
  }, [subagentsList]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_market_subagents', JSON.stringify(marketplaceSubagents));
  }, [marketplaceSubagents]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_anti_auth', JSON.stringify(antigravityAuth));
  }, [antigravityAuth]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_claude_auth', JSON.stringify(claudeAuth));
  }, [claudeAuth]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_gemini_auth', JSON.stringify(geminiAuth));
  }, [geminiAuth]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_copilot_auth', JSON.stringify(copilotAuth));
  }, [copilotAuth]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_codex_auth', JSON.stringify(codexAuth));
  }, [codexAuth]);

  useEffect(() => {
    if (isLoaded.current) localStorage.setItem('cortex_swe_auth', JSON.stringify(sweAuth));
  }, [sweAuth]);

  // Fetch agents and workspace on mount
  useEffect(() => {
    fetchAgents();
    fetchWorkspace();
    fetchMarketplaceSkills();
  }, []);

  const fetchMarketplaceSkills = async () => {
    try {
      const res = await fetch('/api/v1/devbox/agent/marketplace/skills');
      if (res.ok) {
        const data = await res.json();
        setMarketplaceSkills(data.skills || []);
      }
    } catch {
      console.error('Failed to fetch marketplace skills');
    }
  };

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistories]);

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/v1/devbox/agent/list');
      if (res.ok) {
        const data = await res.json();
        const loadedAgents = data.agents || [];
        setAgents(loadedAgents);
        if (loadedAgents.length > 0) {
          setSelectedAgent(loadedAgents[0]);
        }
      } else {
        // Fallback default agents if endpoint not configured
        const fallback: Agent[] = [
          { id: 'antigravity', name: 'Antigravity CLI', description: 'Autonomous agentic pair programmer', status: 'Ready', avatar: '🚀' },
          { id: 'claude', name: 'Claude CLI', description: 'Anthropic Claude Code autonomous engineer', status: 'Ready', avatar: '🧠' },
          { id: 'gemini', name: 'Gemini CLI', description: 'Google DeepMind multimodal coding model', status: 'Ready', avatar: '✨' },
          { id: 'subagent', name: 'Sub-Agents', description: 'Specialized modular engineering assistants', status: 'Ready', avatar: '⚡' }
        ];
        setAgents(fallback);
        setSelectedAgent(fallback[0]);
      }
    } catch (e) {
      const fallback: Agent[] = [
        { id: 'antigravity', name: 'Antigravity CLI', description: 'Autonomous agentic pair programmer', status: 'Ready', avatar: '🚀' },
        { id: 'claude', name: 'Claude CLI', description: 'Anthropic Claude Code autonomous engineer', status: 'Ready', avatar: '🧠' },
        { id: 'gemini', name: 'Gemini CLI', description: 'Google DeepMind multimodal coding model', status: 'Ready', avatar: '✨' },
        { id: 'subagent', name: 'Sub-Agents', description: 'Specialized modular engineering assistants', status: 'Ready', avatar: '⚡' }
      ];
      setAgents(fallback);
      setSelectedAgent(fallback[0]);
    }
  };

  const fetchWorkspace = async () => {
    try {
      const res = await fetch('/api/v1/devbox/agent/workspace/files');
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      }
    } catch (e) {
      console.error('Failed to fetch files:', e);
    }
  };

  const loadFileContent = async (path: string) => {
    try {
      const res = await fetch(`/api/v1/devbox/agent/workspace/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content || '');
        setOriginalContent(data.content || '');
        setSelectedFile(path);
      }
    } catch (e) {
      console.error('Failed to load file content:', e);
    }
  };

  const handleSaveFile = async () => {
    if (!selectedFile) return;
    try {
      const res = await fetch('/api/v1/devbox/agent/workspace/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: fileContent })
      });
      if (res.ok) {
        setOriginalContent(fileContent);
      }
    } catch (e) {
      console.error('Failed to save file:', e);
    }
  };

  const handleExecutePrompt = async () => {
    if (!selectedAgent || !prompt.trim() || isExecuting) return;

    // Check credentials
    if (selectedAgent.id === 'antigravity' && !antigravityAuth.type) {
      setTempAuthType('google');
      setShowAuthModal('antigravity');
      return;
    }
    if (selectedAgent.id === 'claude' && !claudeAuth.type) {
      setTempApiKey('');
      setTempAuthType('session');
      setShowAuthModal('claude');
      return;
    }
    if (selectedAgent.id === 'gemini' && !geminiAuth.type) {
      setTempApiKey('');
      setShowAuthModal('gemini');
      return;
    }

    const currentAgentId = selectedAgent.id;
    const userMsg: ChatMessage = {
      sender: 'user',
      message: prompt,
      timestamp: new Date().toLocaleTimeString()
    };

    setChatHistories(prev => ({
      ...prev,
      [currentAgentId]: [...(prev[currentAgentId] || []), userMsg]
    }));

    setIsExecuting(true);
    setCurrentStatus('Analyzing codebase & instructions...');
    const executedPrompt = prompt;
    setPrompt('');

    try {
      const response = await fetch('/api/v1/devbox/agent/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: currentAgentId,
          prompt: executedPrompt,
          notebook_id: notebookId || '',
          auth: currentAgentId === 'antigravity' ? antigravityAuth :
                currentAgentId === 'claude' ? claudeAuth :
                currentAgentId === 'gemini' ? geminiAuth : null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const assistantMsg: ChatMessage = {
          sender: 'assistant',
          message: data.response || 'Task executed successfully.',
          timestamp: new Date().toLocaleTimeString(),
          type: 'done'
        };

        setChatHistories(prev => ({
          ...prev,
          [currentAgentId]: [...(prev[currentAgentId] || []), assistantMsg]
        }));

        if (data.editedFiles && data.editedFiles.length > 0) {
          setEditedFiles(data.editedFiles);
          fetchWorkspace();
          if (data.editedFiles.includes(selectedFile)) {
            loadFileContent(selectedFile!);
          }
        }
      } else {
        throw new Error('Agent execution failed');
      }
    } catch {
      const errMsg: ChatMessage = {
        sender: 'system',
        message: 'Agent completed execution or returned local fallback.',
        timestamp: new Date().toLocaleTimeString(),
        type: 'log'
      };
      setChatHistories(prev => ({
        ...prev,
        [currentAgentId]: [...(prev[currentAgentId] || []), errMsg]
      }));
    } finally {
      setIsExecuting(false);
      setCurrentStatus('Ready');
    }
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirs(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const renderFileTree = (nodes: WorkspaceFile[], depth = 0) => {
    return nodes.map((node) => {
      const isExpanded = expandedDirs[node.path];
      const isSelected = selectedFile === node.path;
      const isEdited = editedFiles.includes(node.path);

      if (node.isDir) {
        return (
          <div key={node.path} className="select-none">
            <div
              onClick={() => toggleDirectory(node.path)}
              className="flex items-center gap-1.5 py-1 px-2 rounded-md hover:bg-white/5 cursor-pointer text-xs text-white/70 hover:text-white transition-colors"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isExpanded ? <ChevronDown size={14} className="text-white/40" /> : <ChevronRight size={14} className="text-white/40" />}
              <Folder size={14} className="text-sky-400" />
              <span className="truncate">{node.name}</span>
            </div>
            {isExpanded && node.children && renderFileTree(node.children, depth + 1)}
          </div>
        );
      }

      return (
        <div
          key={node.path}
          onClick={() => loadFileContent(node.path)}
          className={`flex items-center justify-between py-1 px-2 rounded-md cursor-pointer text-xs transition-colors ${
            isSelected ? 'bg-sky-500/20 text-sky-300 font-medium' : 'text-white/60 hover:text-white hover:bg-white/5'
          }`}
          style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <FileCode size={14} className={isSelected ? 'text-sky-400' : 'text-white/30'} />
            <span className="truncate">{node.name}</span>
          </div>
          {isEdited && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Modified by agent" />
          )}
        </div>
      );
    });
  };

  return (
    <div className={`flex flex-col h-full bg-slate-950 text-white rounded-2xl overflow-hidden border border-white/10 ${className}`}>
      {/* Top IDE Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/[0.02] border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-500/10 text-sky-400 rounded-xl border border-sky-500/20">
            <Terminal size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-wide">Cortex Agent Studio</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                Autonomous
              </span>
            </div>
            <p className="text-[11px] text-white/40">Grounded code editing, shell sandbox & autonomous agent fleet</p>
          </div>
        </div>

        {/* Agent Selector & Vaults */}
        <div className="flex items-center gap-2">
          <div className="flex bg-white/5 p-1 rounded-xl border border-white/5 gap-1">
            {agents.map((ag) => (
              <button
                key={ag.id}
                onClick={() => setSelectedAgent(ag)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                  selectedAgent?.id === ag.id
                    ? 'bg-sky-500 text-white shadow-md'
                    : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>{ag.avatar}</span>
                <span className="hidden sm:inline">{ag.name}</span>
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowSubagentsModal(true)}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-white/80 hover:text-white flex items-center gap-1.5 transition-all"
          >
            <Bot size={14} className="text-purple-400" />
            <span className="hidden md:inline">Agents Vault</span>
          </button>

          <button
            onClick={() => setShowSkillsModal(true)}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-semibold text-white/80 hover:text-white flex items-center gap-1.5 transition-all"
          >
            <Sparkles size={14} className="text-amber-400" />
            <span className="hidden md:inline">Skills & MCP</span>
          </button>
        </div>
      </div>

      {/* Main 3-Column IDE Layout */}
      <div className="flex-1 grid grid-cols-12 overflow-hidden min-h-0">
        {/* Left Column: File Tree Explorer */}
        <div className="col-span-12 md:col-span-3 border-r border-white/5 flex flex-col bg-white/[0.01]">
          <div className="p-3 border-b border-white/5 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-white/40 flex items-center gap-1.5">
              <Folder size={12} /> Workspace Explorer
            </span>
            <button
              onClick={fetchWorkspace}
              className="p-1 text-white/40 hover:text-white hover:bg-white/5 rounded transition-all"
              title="Refresh Workspace"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-xs">
            {files.length === 0 ? (
              <div className="p-6 text-center text-xs text-white/30 italic">
                Scanning repository...
              </div>
            ) : (
              renderFileTree(files)
            )}
          </div>
        </div>

        {/* Center Column: Code Editor & Diff */}
        <div className="col-span-12 md:col-span-5 border-r border-white/5 flex flex-col bg-slate-950">
          <div className="p-2.5 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-mono text-sky-400 truncate">
                {selectedFile || 'No file selected'}
              </span>
              {fileContent !== originalContent && (
                <span className="text-[10px] text-amber-400 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                  Unsaved
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex bg-white/5 p-0.5 rounded-lg border border-white/5 text-[11px]">
                <button
                  onClick={() => setActiveTab('editor')}
                  className={`px-2 py-1 rounded ${activeTab === 'editor' ? 'bg-sky-500 text-white' : 'text-white/50 hover:text-white'}`}
                >
                  Editor
                </button>
                <button
                  onClick={() => setActiveTab('diff')}
                  className={`px-2 py-1 rounded ${activeTab === 'diff' ? 'bg-sky-500 text-white' : 'text-white/50 hover:text-white'}`}
                >
                  Diff
                </button>
              </div>

              {selectedFile && (
                <button
                  onClick={handleSaveFile}
                  disabled={fileContent === originalContent}
                  className="px-2.5 py-1 bg-sky-500 hover:bg-sky-400 disabled:opacity-30 text-white text-xs font-bold rounded-lg flex items-center gap-1 transition-all"
                >
                  <Save size={12} /> Save
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden bg-black/40">
            {selectedFile ? (
              activeTab === 'editor' ? (
                <textarea
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  className="w-full h-full p-4 bg-transparent font-mono text-xs text-sky-200 resize-none focus:outline-none leading-relaxed"
                  spellCheck={false}
                />
              ) : (
                <div className="w-full h-full p-4 font-mono text-xs overflow-y-auto space-y-1">
                  <div className="text-white/30 pb-2 border-b border-white/5">Original vs Current Diff</div>
                  <pre className="text-emerald-400 whitespace-pre-wrap">{fileContent}</pre>
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-white/30 text-xs space-y-2 p-8 text-center">
                <FileCode size={36} className="text-white/10" />
                <p>Select any code file from the Explorer to view or edit</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Autonomous Agent Execution & Stream */}
        <div className="col-span-12 md:col-span-4 flex flex-col bg-white/[0.01]">
          <div className="p-3 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">
                {selectedAgent?.name || 'Agent'} Stream
              </span>
              <span className={`w-2 h-2 rounded-full ${isExecuting ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
            </div>
            <span className="text-[10px] text-white/40 font-mono">{currentStatus}</span>
          </div>

          {/* Stream Log History */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-xs">
            {(!selectedAgent || !(chatHistories[selectedAgent.id]?.length)) ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-white/30 space-y-3 p-6">
                <Sparkles size={32} className="text-sky-400/20" />
                <p className="text-xs">Awaiting instructions for {selectedAgent?.name || 'the agent'}.</p>
                <div className="text-[10px] text-white/20 border border-dashed border-white/10 p-3 rounded-xl max-w-xs">
                  Tip: Ask the agent to inspect files, implement endpoints, write unit tests, or run builds.
                </div>
              </div>
            ) : (
              chatHistories[selectedAgent.id].map((msg, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-xl border ${
                    msg.sender === 'user'
                      ? 'bg-sky-500/10 border-sky-500/20 text-sky-200'
                      : msg.sender === 'system'
                      ? 'bg-white/5 border-white/5 text-white/60'
                      : 'bg-black/40 border-white/10 text-white'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] text-white/40 mb-1">
                    <span className="font-bold uppercase tracking-wider">{msg.sender}</span>
                    <span>{msg.timestamp}</span>
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed">{msg.message}</div>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>

          {/* Prompt Input Box */}
          <div className="p-3 border-t border-white/5 bg-white/[0.02]">
            <div className="relative flex items-center">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleExecutePrompt();
                  }
                }}
                placeholder={`Prompt ${selectedAgent?.name || 'Agent'}...`}
                rows={2}
                disabled={isExecuting}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 pr-12 text-xs text-white placeholder-white/30 focus:outline-none focus:border-sky-500/50 resize-none font-sans"
              />
              <button
                onClick={handleExecutePrompt}
                disabled={!prompt.trim() || isExecuting}
                className="absolute right-2 bottom-2 p-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-20 text-white rounded-lg transition-all shadow-md"
              >
                {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-Agents Vault Modal */}
      {showSubagentsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-[28px] p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-center pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Bot className="text-purple-400" size={20} />
                <h3 className="text-base font-bold text-white">Sub-Agents Marketplace</h3>
              </div>
              <button onClick={() => setShowSubagentsModal(false)} className="p-1.5 text-white/40 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto p-1">
              {marketplaceSubagents.map((sub) => (
                <div key={sub.id} className="p-3.5 rounded-xl border border-white/10 bg-white/5 space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-white">{sub.name}</h4>
                    <span className="text-[10px] font-mono bg-purple-500/10 text-purple-300 px-2 py-0.5 rounded border border-purple-500/20">
                      {sub.role}
                    </span>
                  </div>
                  <p className="text-[11px] text-white/50">{sub.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Skills & MCP Modal */}
      {showSkillsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-2xl bg-slate-900 border border-white/10 rounded-[28px] p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-center pb-3 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Sparkles className="text-amber-400" size={20} />
                <h3 className="text-base font-bold text-white">Skills & MCP Tooling</h3>
              </div>
              <button onClick={() => setShowSkillsModal(false)} className="p-1.5 text-white/40 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto p-1">
              {skillsList.map((skill) => (
                <div key={skill.id} className="p-3.5 rounded-xl border border-white/10 bg-white/5 space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-white">{skill.name}</h4>
                    <span className="text-[10px] font-mono bg-amber-500/10 text-amber-300 px-2 py-0.5 rounded border border-amber-500/20">
                      {skill.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-white/50">{skill.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Authentication Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-md bg-slate-900 border border-white/10 rounded-[24px] p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center pb-2 border-b border-white/10">
              <h3 className="text-sm font-bold text-white capitalize">Configure {showAuthModal} Auth</h3>
              <button onClick={() => setShowAuthModal(null)} className="p-1 text-white/40 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-bold text-white/50 uppercase">API Key / Token</label>
                <input
                  type="password"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  placeholder="Enter API key..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white font-mono mt-1 focus:outline-none focus:border-sky-500"
                />
              </div>
              <button
                onClick={() => {
                  if (showAuthModal === 'antigravity') {
                    setAntigravityAuth({ type: 'key', user: 'admin', token: tempApiKey });
                  } else if (showAuthModal === 'claude') {
                    setClaudeAuth({ type: 'key', user: 'admin', token: null, apiKey: tempApiKey });
                  } else if (showAuthModal === 'gemini') {
                    setGeminiAuth({ type: 'key', apiKey: tempApiKey });
                  }
                  setShowAuthModal(null);
                }}
                className="w-full py-2.5 bg-sky-500 hover:bg-sky-400 text-white font-bold text-xs rounded-xl transition-all"
              >
                Save & Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

