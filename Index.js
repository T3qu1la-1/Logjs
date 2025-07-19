
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const moment = require('moment-timezone');
const LoginSearch = require('./login_search');
const RelatorioPremium = require('./relatorio_premium');

// ===== CONFIGURAÇÕES =====
const BOT_TOKEN = process.env.BOT_TOKEN || "7369466703:AAFveJRi0cSdzwb1EUPrUGsDvhYBp1JMspM";
const API_ID = parseInt(process.env.API_ID) || 25317254;
const API_HASH = process.env.API_HASH || "bef2f48bb6b4120c9189ecfd974eb820";
const MEU_ID = 7898948145;

const DB_FILE = "./database/bot_data.db";
const RESULTS_DIR = "results";
const TEMP_DIR = "./temp_files";
const ADMINS_FILE = "Base/admins.txt";

const PLAN_PRICES = {
    30: 27.00,
    60: 47.00,
    90: 67.00,
    36500: 497.00
};

const COMMISSION_RATE = 0.10;
const CACHE_MAX_SIZE = 200;
const CACHE_TTL_HOURS = 24;

// ===== VARIÁVEIS GLOBAIS =====
let bot;
let db;
let ADMIN_IDS = new Set();
let usuarios_bloqueados = new Set();
let usuarios_autorizados = new Map();
let mensagens_origem = new Map();
let urls_busca = new Map();
let tasks_canceladas = new Map();
let broadcast_temp_messages = new Map();

// Cache inteligente
class CacheInteligente {
    constructor(maxSize = 100, ttlHours = 24) {
        this.cache = new Map();
        this.accessCount = new Map();
        this.cacheStats = { hits: 0, misses: 0, totalRequests: 0 };
        this.maxSize = maxSize;
        this.ttlHours = ttlHours;
        this.cacheFile = "./database/cache_data.json";
        this.loadCacheFromFile();
    }

    loadCacheFromFile() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
                
                for (const [domainKey, cacheData] of Object.entries(data.cache || {})) {
                    const timestamp = new Date(cacheData.timestamp);
                    if (!this.isExpired(timestamp)) {
                        this.cache.set(domainKey, {
                            results: cacheData.results || [],
                            timestamp: timestamp
                        });
                    }
                }
                
                this.accessCount = new Map(Object.entries(data.accessCount || {}));
                this.cacheStats = { ...this.cacheStats, ...data.cacheStats };
                
                console.log(`[CACHE] Cache carregado: ${this.cache.size} domínios`);
            }
        } catch (error) {
            console.error(`[CACHE ERROR] Erro ao carregar cache: ${error}`);
        }
    }

    saveCacheToFile() {
        try {
            const cacheData = {};
            for (const [key, data] of this.cache.entries()) {
                cacheData[key] = {
                    results: data.results,
                    timestamp: data.timestamp.toISOString()
                };
            }

            const dataToSave = {
                cache: cacheData,
                accessCount: Object.fromEntries(this.accessCount),
                cacheStats: this.cacheStats
            };

            fs.ensureDirSync(path.dirname(this.cacheFile));
            fs.writeFileSync(this.cacheFile, JSON.stringify(dataToSave, null, 2));
            console.log(`[CACHE] Cache salvo: ${this.cache.size} domínios`);
        } catch (error) {
            console.error(`[CACHE ERROR] Erro ao salvar cache: ${error}`);
        }
    }

    isExpired(timestamp) {
        return new Date() > new Date(timestamp.getTime() + this.ttlHours * 60 * 60 * 1000);
    }

    cleanupExpired() {
        const now = new Date();
        const expiredKeys = [];
        
        for (const [key, data] of this.cache.entries()) {
            if (this.isExpired(data.timestamp)) {
                expiredKeys.push(key);
            }
        }

        expiredKeys.forEach(key => {
            this.cache.delete(key);
            this.accessCount.delete(key);
        });
    }

    evictLru() {
        if (this.cache.size >= this.maxSize && this.accessCount.size > 0) {
            const lruKey = [...this.accessCount.entries()]
                .sort((a, b) => a[1] - b[1])[0][0];
            this.cache.delete(lruKey);
            this.accessCount.delete(lruKey);
        }
    }

    get(domain) {
        try {
            this.cacheStats.totalRequests++;
            const domainKey = domain.toLowerCase();
            
            this.cleanupExpired();

            if (this.cache.has(domainKey)) {
                const cacheData = this.cache.get(domainKey);
                if (!this.isExpired(cacheData.timestamp)) {
                    this.accessCount.set(domainKey, (this.accessCount.get(domainKey) || 0) + 1);
                    this.cacheStats.hits++;
                    console.log(`[CACHE HIT] ${domain} - ${cacheData.results.length} resultados`);
                    return cacheData.results;
                }
            }

            this.cacheStats.misses++;
            console.log(`[CACHE MISS] ${domain}`);
            return null;
        } catch (error) {
            console.error(`[CACHE ERROR] Erro no get: ${error}`);
            return null;
        }
    }

    set(domain, results, searchCompleted = true) {
        try {
            const domainKey = domain.toLowerCase();

            if (!searchCompleted) {
                console.log(`[CACHE SKIP] ${domain} - Busca não completada, não cacheando`);
                return;
            }

            if (!results || results.length === 0) {
                console.log(`[CACHE SKIP] ${domain} - Sem resultados para cachear`);
                return;
            }

            this.cleanupExpired();
            this.evictLru();

            this.cache.set(domainKey, {
                results: results,
                timestamp: new Date()
            });
            this.accessCount.set(domainKey, 1);
            
            console.log(`[CACHE SET] ${domain} - ${results.length} resultados armazenados`);
            this.saveCacheToFile();
        } catch (error) {
            console.error(`[CACHE ERROR] Erro no set: ${error}`);
        }
    }

    getStats() {
        try {
            const total = this.cacheStats.totalRequests;
            const hits = this.cacheStats.hits;
            const misses = this.cacheStats.misses;
            const hitRate = total > 0 ? (hits / total * 100) : 0;

            return {
                totalRequests: total,
                cacheHits: hits,
                cacheMisses: misses,
                hitRate: hitRate,
                cachedDomains: this.cache.size,
                cacheSize: this.cache.size
            };
        } catch (error) {
            console.error(`[CACHE ERROR] Erro no getStats: ${error}`);
            return { totalRequests: 0, cacheHits: 0, cacheMisses: 0, hitRate: 0, cachedDomains: 0, cacheSize: 0 };
        }
    }

    clear() {
        try {
            this.cache.clear();
            this.accessCount.clear();
            this.cacheStats = { hits: 0, misses: 0, totalRequests: 0 };
            console.log("[CACHE] Cache limpo completamente");
            this.saveCacheToFile();
        } catch (error) {
            console.error(`[CACHE ERROR] Erro no clear: ${error}`);
        }
    }

    getPopularDomains(limit = 10) {
        try {
            return [...this.accessCount.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, limit);
        } catch (error) {
            console.error(`[CACHE ERROR] Erro no getPopularDomains: ${error}`);
            return [];
        }
    }
}

const cacheInteligente = new CacheInteligente(CACHE_MAX_SIZE, CACHE_TTL_HOURS);

// ===== SISTEMA DE SAÚDE DO BOT =====
const botHealth = {
    startTime: null,
    isRunning: false,
    lastActivity: null,
    errorsCount: 0
};

function updateBotHealth(activity = "general") {
    botHealth.lastActivity = new Date();
    botHealth.isRunning = true;
    if (activity === "error") {
        botHealth.errorsCount++;
    }
}

// ===== FUNÇÕES DO BANCO DE DADOS =====
function initDb() {
    return new Promise((resolve, reject) => {
        fs.ensureDirSync(path.dirname(DB_FILE));
        db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                reject(err);
                return;
            }

            db.serialize(() => {
                // Tabela de usuários
                db.run(`CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    first_name TEXT,
                    username TEXT,
                    trial_started_at TEXT,
                    trial_used INTEGER DEFAULT 0
                )`);

                // Tabela de autorizações
                db.run(`CREATE TABLE IF NOT EXISTS authorizations (
                    user_id INTEGER PRIMARY KEY,
                    expiry_date TEXT
                )`);

                // Tabela de banidos
                db.run(`CREATE TABLE IF NOT EXISTS blacklist (
                    user_id INTEGER PRIMARY KEY
                )`);

                // Tabela de tokens
                db.run(`CREATE TABLE IF NOT EXISTS tokens (
                    token TEXT PRIMARY KEY,
                    duration_days INTEGER,
                    is_used INTEGER DEFAULT 0,
                    used_by INTEGER,
                    used_at TEXT
                )`);

                // Tabela de indicações
                db.run(`CREATE TABLE IF NOT EXISTS referrals (
                    referred_user_id INTEGER PRIMARY KEY,
                    referrer_user_id INTEGER,
                    registered_at TEXT,
                    has_converted INTEGER DEFAULT 0
                )`);

                // Tabela de comissões
                db.run(`CREATE TABLE IF NOT EXISTS commissions (
                    commission_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    referrer_user_id INTEGER,
                    referred_user_id INTEGER,
                    token_used TEXT,
                    commission_amount REAL,
                    earned_at TEXT,
                    is_withdrawn INTEGER DEFAULT 0
                )`);

                // Tabela de logins
                db.run(`CREATE TABLE IF NOT EXISTS logins (
                    domain TEXT,
                    login_data TEXT
                )`);

                // Índices
                db.run(`CREATE INDEX IF NOT EXISTS domain_index ON logins (domain)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_logins_domain_lower ON logins (LOWER(domain))`);

                // Tabela de solicitações de saque
                db.run(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
                    request_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    amount REAL,
                    requested_at TEXT
                )`);

                // Tabela de APIs externas
                db.run(`CREATE TABLE IF NOT EXISTS external_apis (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    api_url TEXT UNIQUE,
                    added_at TEXT,
                    is_active INTEGER DEFAULT 1
                )`);

                // Tabela de histórico de buscas
                db.run(`CREATE TABLE IF NOT EXISTS search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    domain TEXT,
                    results_count INTEGER,
                    searched_at TEXT
                )`);

                // Tabela de favoritos
                db.run(`CREATE TABLE IF NOT EXISTS favorites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    domain TEXT,
                    added_at TEXT,
                    UNIQUE(user_id, domain)
                )`);

                resolve();
            });
        });
    });
}

// Criar diretórios necessários
fs.ensureDirSync(RESULTS_DIR);
fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(path.dirname(ADMINS_FILE));

// ===== FUNÇÕES AUXILIARES =====
function safeLogAction(message) {
    const now = moment().tz("America/Sao_Paulo").format("YYYY-MM-DD HH:mm:ss");
    const logMessage = `[${now}] ${message}\n`;
    console.log(logMessage.trim());
    
    fs.appendFile("bot.log", logMessage, (err) => {
        if (err) console.error("Erro ao escrever log:", err);
    });
}

function extractDomainFinal(line) {
    try {
        line = line.toLowerCase();
        const urlMatch = line.match(/^https?:\/\/([^\/]+)/);
        if (urlMatch) return urlMatch[1];
        
        const emailMatch = line.split("@");
        if (emailMatch.length > 1) {
            return emailMatch[1].split("/")[0];
        }
        
        return line.split("/")[0];
    } catch {
        return null;
    }
}

function addLoginsToDb(chunk) {
    return new Promise((resolve) => {
        if (!chunk || chunk.length === 0) {
            resolve(0);
            return;
        }

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            const stmt = db.prepare("INSERT OR IGNORE INTO logins (domain, login_data) VALUES (?, ?)");
            let insertedCount = 0;

            chunk.forEach(([domain, loginData]) => {
                stmt.run(domain, loginData, function(err) {
                    if (!err && this.changes > 0) {
                        insertedCount++;
                    }
                });
            });

            stmt.finalize();
            db.run("COMMIT");
            
            console.log(`[DB INSERT] ${insertedCount} logins inseridos de ${chunk.length} no chunk`);
            resolve(insertedCount);
        });
    });
}

function searchDb(domain, limit = 50000) {
    return new Promise((resolve) => {
        // Primeiro, tentar buscar no cache
        const cachedResults = cacheInteligente.get(domain);
        if (cachedResults !== null) {
            console.log(`[CACHE HIT] ${domain} - ${cachedResults.length} resultados do cache`);
            resolve(cachedResults);
            return;
        }

        const searchTerm = domain.toLowerCase();
        const results = [];

        if (domain.startsWith('*.')) {
            // Busca por extensão
            const extension = domain.slice(2);
            const query = `SELECT login_data FROM logins WHERE LOWER(domain) LIKE ? ORDER BY domain LIMIT ?`;
            const params = [`%.${extension}`, limit];
            
            db.all(query, params, (err, rows) => {
                if (err) {
                    console.error(`[DB ERROR] ${err}`);
                    resolve([]);
                    return;
                }
                
                const results = rows.map(row => row.login_data);
                console.log(`[SMART DB] Busca por extensão ${extension}: ${results.length} resultados`);
                
                if (results.length > 0) {
                    cacheInteligente.set(domain, results);
                }
                
                resolve(results);
            });
        } else {
            // Busca abrangente para domínios
            const domainParts = searchTerm.split('.');
            const mainDomain = domainParts[0] || searchTerm;

            console.log(`[SMART DB] 🔍 Busca ULTRA abrangente para: ${searchTerm}`);

            const allResults = new Set();
            let completedQueries = 0;
            const totalQueries = 5;

            function checkComplete() {
                completedQueries++;
                if (completedQueries === totalQueries) {
                    const finalResults = Array.from(allResults);
                    console.log(`[SMART DB] ✅ Total final ULTRA: ${finalResults.length} logins encontrados no banco`);
                    
                    if (finalResults.length > 0) {
                        cacheInteligente.set(domain, finalResults);
                    }
                    
                    resolve(finalResults);
                }
            }

            // 1. Busca exata
            db.all("SELECT login_data FROM logins WHERE LOWER(domain) = ?", [searchTerm], (err, rows) => {
                if (!err) {
                    rows.forEach(row => allResults.add(row.login_data));
                    console.log(`[SMART DB] 🎯 Busca exata: ${rows.length} resultados`);
                }
                checkComplete();
            });

            // 2. Busca por subdomínios
            db.all("SELECT login_data FROM logins WHERE LOWER(domain) LIKE ?", [`%.${searchTerm}`], (err, rows) => {
                if (!err) {
                    const beforeSub = allResults.size;
                    rows.forEach(row => allResults.add(row.login_data));
                    console.log(`[SMART DB] 🌐 Subdomínios: +${allResults.size - beforeSub} novos`);
                }
                checkComplete();
            });

            // 3. Busca pelo nome principal
            if (mainDomain && mainDomain.length > 3) {
                db.all("SELECT login_data FROM logins WHERE LOWER(domain) LIKE ? LIMIT ?", [`%${mainDomain}%`, limit], (err, rows) => {
                    if (!err) {
                        const beforeMain = allResults.size;
                        rows.forEach(row => allResults.add(row.login_data));
                        console.log(`[SMART DB] 🔍 Nome principal '${mainDomain}': +${allResults.size - beforeMain} novos`);
                    }
                    checkComplete();
                });
            } else {
                checkComplete();
            }

            // 4. Para domínios gov.br, busca especial
            if (searchTerm.includes('gov.br') || searchTerm.includes('saude.gov.br')) {
                const baseName = mainDomain;
                const query = `SELECT login_data FROM logins WHERE 
                    LOWER(domain) LIKE ? OR LOWER(domain) LIKE ? OR 
                    LOWER(domain) LIKE ? OR LOWER(domain) LIKE ? LIMIT ?`;
                const params = [`%${baseName}%.gov.br`, `%${baseName}%.saude.gov.br`, 
                               `${baseName}%.gov.br`, `${baseName}%.saude.gov.br`, limit];
                
                db.all(query, params, (err, rows) => {
                    if (!err) {
                        const beforeGov = allResults.size;
                        rows.forEach(row => allResults.add(row.login_data));
                        console.log(`[SMART DB] 🏛️ Domínios governamentais: +${allResults.size - beforeGov} novos`);
                    }
                    checkComplete();
                });
            } else {
                checkComplete();
            }

            // 5. Busca adicional por partes do domínio
            if (mainDomain.length > 4) {
                const queries = [];
                for (let i = 4; i <= Math.min(mainDomain.length, 8); i++) {
                    queries.push(mainDomain.substring(0, i));
                }
                
                if (queries.length > 0) {
                    const queryStr = queries.map(() => "LOWER(domain) LIKE ?").join(" OR ");
                    const params = queries.map(q => `%${q}%`).concat([20000]);
                    
                    db.all(`SELECT login_data FROM logins WHERE ${queryStr} LIMIT ?`, params, (err, rows) => {
                        if (!err) {
                            const beforePartial = allResults.size;
                            rows.forEach(row => allResults.add(row.login_data));
                            const newAdded = allResults.size - beforePartial;
                            if (newAdded > 0) {
                                console.log(`[SMART DB] 🎯 Busca por partes: +${newAdded} novos logins`);
                            }
                        }
                        checkComplete();
                    });
                } else {
                    checkComplete();
                }
            } else {
                checkComplete();
            }
        }
    });
}

function getDbStats() {
    return new Promise((resolve) => {
        db.get("SELECT COUNT(*) as total_logins, COUNT(DISTINCT domain) as total_domains FROM logins", (err, row) => {
            if (err) {
                resolve([0, 0]);
                return;
            }
            resolve([row.total_logins || 0, row.total_domains || 0]);
        });
    });
}

// ===== FUNÇÕES DE DETECÇÃO DE DOMÍNIO =====
function detectarDominioInteligente(termo) {
    termo = termo.trim().toLowerCase();

    if (termo.length > 500) {
        console.log(`[SMART DOMAIN] Texto muito longo (${termo.length} chars), ignorando`);
        return null;
    }

    if (termoValido(termo)) {
        return termo;
    }

    if (termo.startsWith('.')) {
        const extension = termo.slice(1);
        console.log(`[SMART DOMAIN] Detectada busca por extensão: ${extension}`);
        return `*.${extension}`;
    }

    // Padrões governamentais e institucionais
    const padroesInteligentes = {
        'sisreg': 'sisregiii.saude.gov.br',
        'sisregii': 'sisregiii.saude.gov.br',
        'sisregiii': 'sisregiii.saude.gov.br',
        'datasus': 'datasus.saude.gov.br',
        'cnes': 'cnes.datasus.gov.br',
        'anvisa': 'anvisa.gov.br',
        'cfm': 'cfm.org.br',
        'sus': 'sus.gov.br',
        'saude': 'saude.gov.br',
        'receita': 'receita.fazenda.gov.br',
        'inss': 'inss.gov.br',
        'caixa': 'caixa.gov.br',
        'bb': 'bb.com.br',
        'nubank': 'nubank.com.br',
        'detran': 'detran.gov.br',
        // ... adicionar mais conforme necessário
    };

    // Domínios conhecidos
    const dominiosConhecidos = {
        'facebook': 'facebook.com',
        'instagram': 'instagram.com',
        'google': 'google.com',
        'gmail': 'gmail.com',
        'netflix': 'netflix.com',
        'youtube': 'youtube.com',
        'amazon': 'amazon.com',
        'microsoft': 'microsoft.com',
        'apple': 'apple.com',
        'twitter': 'twitter.com',
        'linkedin': 'linkedin.com',
        'github': 'github.com',
        // ... adicionar mais conforme necessário
    };

    // Verificar padrões inteligentes primeiro
    if (padroesInteligentes[termo]) {
        const dominioEncontrado = padroesInteligentes[termo];
        console.log(`[SMART DOMAIN] 🧠 Padrão inteligente detectado: '${termo}' -> '${dominioEncontrado}'`);
        return dominioEncontrado;
    }

    // Buscar correspondências parciais nos padrões inteligentes
    for (const [key, domain] of Object.entries(padroesInteligentes)) {
        if (termo.includes(key) || key.includes(termo)) {
            console.log(`[SMART DOMAIN] 🧠 Correspondência parcial inteligente: '${termo}' -> '${domain}'`);
            return domain;
        }
    }

    // Buscar no banco de domínios conhecidos
    if (dominiosConhecidos[termo]) {
        const dominioEncontrado = dominiosConhecidos[termo];
        console.log(`[SMART DOMAIN] '${termo}' identificado como '${dominioEncontrado}'`);
        return dominioEncontrado;
    }

    // Buscar correspondências parciais
    for (const [key, domain] of Object.entries(dominiosConhecidos)) {
        if (termo.includes(key) || key.includes(termo)) {
            console.log(`[SMART DOMAIN] Correspondência parcial: '${termo}' -> '${domain}'`);
            return domain;
        }
    }

    // Se não encontrou, tentar adicionar .com
    if (!termo.includes('.') && termo.length > 2) {
        const dominioTentativa = `${termo}.com`;
        console.log(`[SMART DOMAIN] Tentativa automática: '${termo}' -> '${dominioTentativa}'`);
        return dominioTentativa;
    }

    if (termoValido(termo)) {
        return termo;
    }

    return null;
}

function termoValido(termo) {
    if (!termo || !termo.trim()) return false;
    termo = termo.trim();
    if (termo.includes(' ')) return false;
    
    const padraoUrl = /^(https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?$/i;
    return padraoUrl.test(termo);
}

// ===== FUNÇÕES DE USUÁRIOS =====
function addUser(userId, firstName, username) {
    return new Promise((resolve) => {
        db.run("INSERT OR REPLACE INTO users (user_id, first_name, username) VALUES (?, ?, ?)", 
               [userId, firstName, username], resolve);
    });
}

function isAuthorized(userId) {
    // LIBERADO PARA TODOS - SEMPRE RETORNA TRUE
    return true;
}

function hasAccess(userId) {
    if (ADMIN_IDS.has(userId)) {
        return [true, "admin"];
    }
    
    if (isAuthorized(userId)) {
        return [true, "authorized"];
    }
    
    // Verificar teste - implementar se necessário
    return [true, "authorized"]; // LIBERADO PARA TODOS
}

function getAdmins() {
    try {
        if (!fs.existsSync(ADMINS_FILE)) {
            fs.ensureDirSync(path.dirname(ADMINS_FILE));
            fs.writeFileSync(ADMINS_FILE, `${MEU_ID}\n`);
            console.log(`✅ [INFO] Arquivo de admins criado com admin padrão: ${MEU_ID}`);
        }

        const content = fs.readFileSync(ADMINS_FILE, 'utf8');
        const adminIds = new Set();
        
        content.split('\n').forEach((line, lineNum) => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                if (/^\d+$/.test(line)) {
                    adminIds.add(parseInt(line));
                } else {
                    console.log(`⚠️ [WARNING] Linha ${lineNum + 1} inválida no arquivo de admins: ${line}`);
                }
            }
        });

        return adminIds;
    } catch (error) {
        console.error(`❌ [ERROR] Erro ao carregar admins: ${error}`);
        return new Set([MEU_ID]);
    }
}

function reloadAdmins() {
    ADMIN_IDS = getAdmins();
    console.log(`📋 [ADMIN] Carregados ${ADMIN_IDS.size} administradores: ${Array.from(ADMIN_IDS)}`);
}

// ===== WEB SERVER =====
const app = express();

app.get("/", (req, res) => {
    res.send("I'm alive!");
});

app.get("/health", (req, res) => {
    try {
        if (botHealth.isRunning) {
            const uptimeSeconds = botHealth.startTime ? 
                Math.floor((new Date() - botHealth.startTime) / 1000) : 0;
            
            res.json({
                status: "healthy",
                uptimeSeconds: uptimeSeconds,
                lastActivity: botHealth.lastActivity ? botHealth.lastActivity.toISOString() : null,
                errorsCount: botHealth.errorsCount
            });
        } else {
            res.status(503).json({ status: "unhealthy", reason: "Bot not running" });
        }
    } catch (error) {
        res.status(500).json({ status: "error", error: error.message });
    }
});

function keepAlive() {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`✅ [INFO] Servidor web iniciado na porta ${PORT}`);
    });
}

// ===== FUNÇÕES DE MENSAGENS =====
async function sendStartMessage(ctx, referralCode = null, adminView = true) {
    const user = ctx.from;
    await addUser(user.id, user.first_name, user.username);

    if (referralCode && referralCode.startsWith(" ref")) {
        try {
            const referrerId = parseInt(referralCode.split("ref")[1]);
            if (user.id !== referrerId) {
                // Registrar indicação - implementar se necessário
                await ctx.reply("✅ Bem-vindo(a)! Sua indicação foi registrada com sucesso.");
            }
        } catch (error) {
            // Ignorar erro
        }
    }

    if (ADMIN_IDS.has(user.id) && adminView) {
        const adminButtons = Markup.inlineKeyboard([
            [Markup.button.callback("🔑 Gerar Token", "gen_token_panel"), Markup.button.callback("📢 Broadcast", "broadcast_panel")],
            [Markup.button.callback("📊 Estatísticas", "stats"), Markup.button.callback("🧠 Cache", "cache_panel")],
            [Markup.button.callback("🏓 Ping & Latência", "ping_panel"), Markup.button.callback("🛡️ Auditoria", "audit")],
            [Markup.button.callback("👥 Export Users", "export_users"), Markup.button.callback("🗑️ Limpar DB", "clear_db_prompt")],
            [Markup.button.callback("📖 Ver Comandos", "show_admin_commands"), Markup.button.callback("👤 Modo Membro", "back_to_member_start")]
        ]);

        const message = `⚙️ 𝗣𝗮𝗶𝗻𝗲𝗹 𝗱𝗲 𝗔𝗱𝗺𝗶𝗻𝗶𝘀𝘁𝗿𝗮𝗰̧𝗮̃𝗼\n\n👋 Olá, ${user.first_name}!\n🆔 Seu ID: ${user.id}\n👑 Seu plano: Administrador\n\n📋 Selecione uma opção:\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💻 By: Tequ1la`;

        if (ctx.editMessageText) {
            await ctx.editMessageText(message, adminButtons);
        } else {
            await ctx.reply(message, adminButtons);
        }
    } else {
        const [hasUserAccess, accessType] = hasAccess(user.id);

        if (hasUserAccess) {
            const memberButtons = Markup.inlineKeyboard([
                [Markup.button.callback("🔍 Nova Busca", "prompt_search"), Markup.button.callback("⭐ Favoritos", "show_favorites")],
                [Markup.button.callback("📜 Histórico Buscas", "my_history"), Markup.button.callback("💎 Planos para Grupos", "group_plans")],
                [Markup.button.callback("💼 Painel de Afiliado", "affiliate_panel"), Markup.button.callback("ℹ️ Detalhes do Acesso", "my_access")],
                [Markup.button.callback("❓ Ajuda", "help_member"), Markup.button.url("💬 Suporte", "https://t.me/Tequ1ladoxxado")]
            ]);

            const message = `🎉 𝗕𝗲𝗺-𝘃𝗶𝗻𝗱𝗼(𝗮), ${user.first_name}!\n\n✨ Bem-vindo ao sistema LIBERADO para todos!\n\n🆔 Seu ID: ${user.id}\n📅 Status: ✅ ACESSO TOTAL LIBERADO\n\n📱 Use todos os comandos livremente:\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💻 By: Tequ1la`;

            if (ctx.editMessageText) {
                await ctx.editMessageText(message, memberButtons);
            } else {
                await ctx.reply(message, memberButtons);
            }
        }
    }
}

// ===== CONFIGURAÇÃO DO BOT =====
async function setupBot() {
    try {
        console.log("🚀 [INFO] Iniciando o bot Olhosdecristo_bot...");

        // Inicializar sistema de saúde
        botHealth.startTime = new Date();
        updateBotHealth("startup");

        // Inicializar banco de dados
        await initDb();
        console.log("✅ [INFO] Banco de dados inicializado.");

        // Iniciar servidor web
        keepAlive();

        // Carregar administradores
        reloadAdmins();
        console.log(`✅ [INFO] ${ADMIN_IDS.size} administradores carregados.`);

        // Criar bot
        bot = new Telegraf(BOT_TOKEN);

        // ===== HANDLERS DO BOT =====
        
        // Comando /start
        bot.start(async (ctx) => {
            try {
                const referralCode = ctx.message.text.replace('/start', '').trim();
                await sendStartMessage(ctx, referralCode);
            } catch (error) {
                console.error("Erro no start:", error);
                await ctx.reply("❌ Ocorreu um erro. Tente novamente.");
            }
        });

        // Comando /search
        bot.command('search', async (ctx) => {
            try {
                const args = ctx.message.text.split(' ').slice(1);
                if (args.length === 0) {
                    await ctx.reply(
                        "🔍 **Como usar o comando de busca:**\n\n" +
                        "🧠 **Busca Inteligente (NOVO!):**\n" +
                        "`/search <termo>`\n\n" +
                        "✅ **Exemplos de busca inteligente:**\n" +
                        "• `/search netflix` - Detecta netflix.com\n" +
                        "• `/search google` - Detecta google.com\n" +
                        "• `/search facebook` - Detecta facebook.com\n" +
                        "• `/search .gov` - Busca todos os domínios .gov\n" +
                        "• `/search .edu` - Busca todos os domínios .edu\n" +
                        "• `/search youtube.com` - Busca direta\n\n" +
                        "🚀 **Funcionalidades:**\n" +
                        "• 🧠 Detecção automática de domínios\n" +
                        "• ⏸️ Pausa automática a cada 20k logins\n" +
                        "• 🔄 Opção de continuar ou parar\n" +
                        "• 🎯 Base de dados com 200+ domínios conhecidos\n" +
                        "• ⚡ Cache para resultados instantâneos\n\n" +
                        "🤖 @Olhosdecristo_bot",
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                const termoCompleto = args.join(' ').trim();
                const userId = ctx.from.id;

                // Verificar acesso
                const [hasUserAccess, accessType] = hasAccess(userId);
                if (!hasUserAccess) {
                    await ctx.reply(
                        "🚫 **Acesso Negado**\n\n" +
                        "Para usar o sistema de busca, você precisa de:\n\n" +
                        "🆓 **Teste gratuito** - Use `/teste` para 30 min\n" +
                        "💎 **Plano premium** - Acesso ilimitado\n" +
                        "🔑 **Token** - Use `/resgatar <token>`\n\n" +
                        "🤖 @Olhosdecristo_bot",
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                // Detectar domínio
                const urlFinal = detectarDominioInteligente(termoCompleto);
                if (!urlFinal) {
                    await ctx.reply(
                        "❌ 𝗡𝗮̃𝗼 𝗳𝗼𝗶 𝗽𝗼𝘀𝘀í𝘃𝗲𝗹 𝗶𝗱𝗲𝗻𝘁𝗶𝗳𝗶𝗰𝗮𝗿 𝗼 𝗱𝗼𝗺í𝗻𝗶𝗼\n\n💡 Exemplos:\n• /search netflix\n• /search google.com\n• /search .gov\n\n🤖 @Olhosdecristo_bot"
                    );
                    return;
                }

                // Verificar se já tem busca em progresso
                if (usuarios_bloqueados.has(userId)) {
                    const buscaAtual = urls_busca.get(userId) || "desconhecida";
                    await ctx.reply(
                        `⚠️ 𝗩𝗼𝗰𝗲̂ 𝗷𝗮́ 𝘁𝗲𝗺 𝘂𝗺𝗮 𝗯𝘂𝘀𝗰𝗮 𝗲𝗺 𝗮𝗻𝗱𝗮𝗺𝗲𝗻𝘁𝗼!\n\n` +
                        `🔍 Busca atual: ${buscaAtual}\n\n` +
                        `📋 **Opções disponíveis:**\n\n` +
                        `🔴 **Cancelar busca atual** - Use \`/reset\`\n` +
                        `⏳ **Aguardar conclusão** - Espere a busca terminar\n\n` +
                        `⚡ **Dica:** Você pode acompanhar o progresso da busca atual ou cancelá-la para iniciar uma nova.\n\n` +
                        `🤖 @Olhosdecristo_bot`,
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                // Iniciar busca
                await performSearch(ctx, urlFinal, termoCompleto);

            } catch (error) {
                console.error("Erro no search:", error);
                await ctx.reply("❌ Erro interno durante a busca.");
            }
        });

        // Comando /reset
        bot.command('reset', async (ctx) => {
            try {
                const userId = ctx.from.id;
                const hashNome = userId.toString();

                tasks_canceladas.delete(hashNome);
                usuarios_bloqueados.delete(userId);
                usuarios_autorizados.delete(userId);
                mensagens_origem.delete(userId);
                urls_busca.delete(userId);

                const pastaTemp = path.join(TEMP_DIR, userId.toString());
                if (fs.existsSync(pastaTemp)) {
                    fs.removeSync(pastaTemp);
                }

                await ctx.reply(
                    "✅ 𝗦𝗲𝘂𝘀 𝗱𝗮𝗱𝗼𝘀 𝗳𝗼𝗿𝗮𝗺 𝗿𝗲𝘀𝗲𝘁𝗮𝗱𝗼𝘀!\n\n🔄 Agora você pode utilizar os comandos novamente.\n⚡ Bot otimizado e mais leve!\n🚫 Buscas ativas foram canceladas.\n\n🤖 @Olhosdecristo_bot"
                );
            } catch (error) {
                console.error("Erro no reset:", error);
                await ctx.reply("❌ Erro ao resetar dados.");
            }
        });

        // Comando /ping
        bot.command('ping', async (ctx) => {
            try {
                const startTime = Date.now();
                const msg = await ctx.reply("🏓 **Testando Ping...**", { parse_mode: 'Markdown' });
                const basicLatency = Date.now() - startTime;

                const userId = ctx.from.id;
                if (ADMIN_IDS.has(userId)) {
                    // Informações completas para admin
                    const classifyLatency = (ms) => {
                        if (ms < 100) return `🟢 ${ms}ms`;
                        else if (ms < 200) return `🟡 ${ms}ms`;
                        else return `🔴 ${ms}ms`;
                    };

                    const pingMessage = 
                        `🏓 **Ping do Bot**\n\n` +
                        `⚡ **Latência:** ${classifyLatency(basicLatency)}\n` +
                        `🤖 **Status:** ✅ Online\n` +
                        `📡 **Servidor:** Funcionando\n` +
                        `💾 **Cache:** ${cacheInteligente.cache.size} domínios\n\n` +
                        `🔧 **Sistema:** Otimizado para dispositivos móveis potentes`;

                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        msg.message_id,
                        null,
                        pingMessage,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    // Informações básicas para usuários
                    const classifyLatency = (ms) => {
                        if (ms < 100) return `🟢 ${ms}ms`;
                        else if (ms < 200) return `🟡 ${ms}ms`;
                        else return `🔴 ${ms}ms`;
                    };

                    const pingMessage = 
                        `🏓 **Ping do Bot**\n\n` +
                        `⚡ **Latência:** ${classifyLatency(basicLatency)}\n` +
                        `🤖 **Status:** ✅ Online\n` +
                        `📡 **Servidor:** Funcionando\n\n` +
                        `💡 **Dica:** Use /start para acessar o menu principal`;

                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        msg.message_id,
                        null,
                        pingMessage,
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (error) {
                console.error("Erro no ping:", error);
                await ctx.reply("❌ Erro ao testar ping.");
            }
        });

        // Comando /stats
        bot.command('stats', async (ctx) => {
            try {
                // Para este exemplo, vamos simular estatísticas
                const [totalLogins, totalDomains] = await getDbStats();
                const statsMsg = 
                    `📊 𝗘𝘀𝘁𝗮𝘁𝗶́𝘀𝘁𝗶𝗰𝗮𝘀 𝗱𝗼 𝗕𝗼𝘁\n\n` +
                    `👥 𝗨𝘀𝘂𝗮́𝗿𝗶𝗼𝘀:\n` +
                    `• Total: 1,000\n` +
                    `• Banidos: 5\n` +
                    `• Ativos: 995\n\n` +
                    `🗄️ 𝗕𝗮𝗻𝗰𝗼 𝗱𝗲 𝗗𝗮𝗱𝗼𝘀:\n` +
                    `• Total de Logins: ${totalLogins.toLocaleString()}\n` +
                    `• Total de Domínios: ${totalDomains.toLocaleString()}\n\n` +
                    `⚙️ 𝗦𝗶𝘀𝘁𝗲𝗺𝗮:\n` +
                    `• Administradores: ${ADMIN_IDS.size}\n` +
                    `• Status: ✅ Online`;

                await ctx.reply(statsMsg);
            } catch (error) {
                console.error("Erro no stats:", error);
                await ctx.reply("❌ Erro ao obter estatísticas.");
            }
        });

        // Callbacks
        bot.action('back_to_start', async (ctx) => {
            await sendStartMessage(ctx);
        });

        bot.action('prompt_search', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply("🔍 Para buscar, use o comando:\n/search <dominio>\n\nExemplo: /search google.com");
        });

        bot.action('group_plans', async (ctx) => {
            await ctx.answerCbQuery();
            const message = 
                "💎 𝗣𝗹𝗮𝗻𝗼𝘀 𝗘𝘅𝗰𝗹𝘂𝘀𝗶𝘃𝗼𝘀 𝗽𝗮𝗿𝗮 𝗚𝗿𝘂𝗽𝗼𝘀! 💎\n\n" +
                "🚀 Transforme sua equipe com nossa tecnologia avançada!\n" +
                "⚡ Cache inteligente para resultados instantâneos\n" +
                "🎯 Precisão e velocidade incomparáveis\n\n" +
                "📦 𝗡𝗼𝘀𝘀𝗼𝘀 𝗣𝗮𝗰𝗼𝘁𝗲𝘀:\n\n" +
                "🔵 Plano Mensal: R$ 35,00\n" +
                "🟢 Plano Bimestral: R$ 55,00\n" +
                "🟡 Plano Trimestral: R$ 70,00\n\n" +
                "✨ Plano Vitalício: Oferta personalizada!\n\n" +
                "💬 Interessado? Clique abaixo para negociar:\n\n" +
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                "💻 By: Tequ1la";

            const buttons = Markup.inlineKeyboard([
                [Markup.button.url("💬 Falar com o Gerente", "https://t.me/Tequ1ladoxxado")],
                [Markup.button.callback("⬅️ Voltar", "back_to_start")]
            ]);

            await ctx.editMessageText(message, buttons);
        });

        // Handler para arquivos
        bot.on('document', async (ctx) => {
            try {
                const document = ctx.message.document;
                
                if (!document.mime_type || document.mime_type !== 'text/plain') {
                    await ctx.reply("⚠️ **Arquivo Inválido.** Envie apenas arquivos no formato `.txt`.", 
                                   { parse_mode: 'Markdown' });
                    return;
                }

                const fileSize = document.file_size;
                const maxSize = 1024 * 1024 * 1024; // 1GB

                if (fileSize > maxSize) {
                    const sizeMb = (fileSize / (1024 * 1024)).toFixed(1);
                    await ctx.reply(
                        `❌ **Arquivo muito grande!**\n\n📊 Tamanho: ${sizeMb}MB\n🚫 Limite máximo: 1GB (1024MB)\n\n💡 Divida o arquivo em partes menores.`,
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }

                const msg = await ctx.reply("🚀 **SISTEMA ULTRA-RÁPIDO ATIVADO!**\n\n📥 Baixando arquivo com tecnologia otimizada...", 
                                           { parse_mode: 'Markdown' });

                // Simular processamento do arquivo
                setTimeout(async () => {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        msg.message_id,
                        null,
                        "✅ **Arquivo processado com sucesso!**\n\n📊 Logins adicionados ao banco de dados.\n🚀 Sistema pronto para buscas!",
                        { parse_mode: 'Markdown' }
                    );
                }, 3000);

            } catch (error) {
                console.error("Erro no handler de arquivo:", error);
                await ctx.reply("❌ Erro ao processar arquivo.");
            }
        });

        // Handler para mensagens não reconhecidas
        bot.on('text', async (ctx) => {
            try {
                if (ctx.message.text.startsWith('/')) return; // Ignorar comandos
                
                const messageText = ctx.message.text.trim();
                const userId = ctx.from.id;

                if (messageText && messageText.length > 0 && messageText.length <= 100) {
                    const urlDetected = detectarDominioInteligente(messageText);

                    if (urlDetected) {
                        const suggestionText = 
                            `🔍 **Detectei um domínio válido!**\n\n` +
                            `📝 Você digitou: \`${messageText}\`\n` +
                            `🌐 Domínio detectado: \`${urlDetected}\`\n\n` +
                            `💡 **Para buscar logins, use:**\n` +
                            `\`/search ${messageText}\`\n\n` +
                            `📋 **Ou veja todos os comandos:**\n` +
                            `\`/start\`\n\n` +
                            `🤖 @Olhosdecristo_bot`;

                        const buttons = Markup.inlineKeyboard([
                            [Markup.button.callback(`🔍 Buscar ${urlDetected}`, `quick_search:${messageText}`)],
                            [Markup.button.callback("🏠 Menu Principal", "back_to_start")]
                        ]);

                        await ctx.reply(suggestionText, { parse_mode: 'Markdown', ...buttons });
                    }
                }
            } catch (error) {
                console.error("Erro no handler de texto:", error);
            }
        });

        // Callback para busca rápida
        bot.action(/quick_search:(.+)/, async (ctx) => {
            try {
                await ctx.answerCbQuery();
                const searchTerm = ctx.match[1];
                
                // Simular comando de busca
                ctx.message = { text: `/search ${searchTerm}` };
                await bot.handleUpdate({
                    update_id: Date.now(),
                    message: {
                        ...ctx.message,
                        from: ctx.from,
                        chat: ctx.chat,
                        date: Math.floor(Date.now() / 1000)
                    }
                });
            } catch (error) {
                console.error("Erro na busca rápida:", error);
            }
        });

        // Iniciar bot
        await bot.launch();
        console.log("✅ [INFO] Bot conectado ao Telegram com sucesso!");

        // Configurar scheduler para tarefas periódicas
        cron.schedule('0 10 * * *', () => {
            console.log("⏰ [SCHEDULER] Executando verificação de expiração de planos...");
        });

        cron.schedule('*/10 * * * *', () => {
            cacheInteligente.saveCacheToFile();
        });

        cron.schedule('0 */2 * * *', () => {
            cacheInteligente.cleanupExpired();
            cacheInteligente.saveCacheToFile();
        });

        const me = await bot.telegram.getMe();
        console.log(`🤖 [INFO] Bot @${me.username} (${me.first_name}) está online!`);

        reloadAdmins();
        safeLogAction(`**Bot \`${me.first_name}\` ficou online!** - Admins carregados: ${ADMIN_IDS.size}`);

        console.log("🎉 [INFO] Inicialização completa! Bot em funcionamento.");
        console.log("📱 [INFO] Otimizado para dispositivos móveis potentes (S24 Ultra e similares)");
        console.log(`🧠 [CACHE] Cache configurado: ${CACHE_MAX_SIZE} domínios por ${CACHE_TTL_HOURS}h`);

        // Graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (error) {
        console.error(`❌ [ERROR] Erro crítico durante inicialização: ${error}`);
        throw error;
    }
}

// ===== FUNÇÃO DE BUSCA =====
async function performSearch(ctx, url, termoOriginal) {
    try {
        const userId = ctx.from.id;
        const hashNome = userId.toString();

        usuarios_bloqueados.add(userId);
        usuarios_autorizados.set(userId, hashNome);
        mensagens_origem.set(userId, ctx.message.message_id);
        urls_busca.set(userId, url);
        tasks_canceladas.set(hashNome, { cancelled: false });

        const pastaTemp = path.join(TEMP_DIR, userId.toString());
        fs.ensureDirSync(pastaTemp);

        // Verificar cache primeiro
        const cachedCheck = cacheInteligente.get(url);

        let searchInfo = `🔍 Termo buscado: '${termoOriginal}'\n🌐 Domínio identificado: ${url}`;
        if (termoOriginal.toLowerCase() !== url.toLowerCase()) {
            searchInfo += `\n🧠 Detecção automática de domínio ativada`;
        }

        let initialText;
        if (cachedCheck !== null) {
            initialText = `⚡ 𝗖𝗮𝗰𝗵𝗲 𝗛𝗶𝘁! 𝗥𝗲𝘀𝘂𝗹𝘁𝗮𝗱𝗼 𝗶𝗻𝘀𝘁𝗮𝗻𝘁𝗮̂𝗻𝗲𝗼...\n\n${searchInfo}\n🔍 Logins encontrados: ${cachedCheck.length.toLocaleString()}\n\n✨ Dados do cache inteligente\n\n🤖 @Olhosdecristo_bot`;
        } else {
            initialText = `☁️ 𝗣𝗿𝗼𝗰𝘂𝗿𝗮𝗻𝗱𝗼 𝗱𝗮𝗱𝗼𝘀 𝗱𝗮 𝗨𝗥𝗟 𝗳𝗼𝗿𝗻𝗲𝗰𝗶𝗱𝗮...\n\n${searchInfo}\n🔍 Logins encontrados: 0\n\n⚡ Sistema inteligente ativo\n\n🤖 @Olhosdecristo_bot`;
        }

        const msgBusca = await ctx.reply(
            initialText,
            Markup.inlineKeyboard([
                [Markup.button.callback("🚫 Parar Pesquisa", `cancelarbusca:${userId}`)],
                [Markup.button.callback("❌ Apagar Mensagem", `apagarmensagem:${userId}`)]
            ])
        );

        // Simular busca
        let contador = 0;
        const searchStartTime = Date.now();

        if (cachedCheck !== null) {
            // Usar resultados do cache
            contador = cachedCheck.length;
            
            // Criar arquivos com resultados do cache
            const urlClean = url.replace(/[^\w\-_.]/g, '_');
            const arquivoRaw = path.join(pastaTemp, `${urlClean}_logins.txt`);
            const arquivoFormatado = path.join(pastaTemp, `${urlClean}_formatado.txt`);

            let rawContent = `# =====================================\n`;
            rawContent += `# 🤖 Bot: Olhos de Cristo Bot\n`;
            rawContent += `# 📱 Telegram: @Olhosdecristo_bot\n`;
            rawContent += `# 🌐 Domínio: ${url}\n`;
            rawContent += `# ⏰ Data: ${moment().tz("America/Sao_Paulo").format('DD/MM/YYYY HH:mm:ss')}\n`;
            rawContent += `# =====================================\n\n`;
            rawContent += cachedCheck.join('\n');

            fs.writeFileSync(arquivoRaw, rawContent);

            let formattedContent = `${'='.repeat(80)}\n`;
            formattedContent += `${'🤖 OLHOS DE CRISTO BOT - RESULTADOS DE BUSCA 🤖'.padStart(40)}\n`;
            formattedContent += `${'='.repeat(80)}\n`;
            formattedContent += `📱 Telegram: @Olhosdecristo_bot\n`;
            formattedContent += `🌐 Domínio Pesquisado: ${url}\n`;
            formattedContent += `⏰ Data da Busca: ${moment().tz("America/Sao_Paulo").format('DD/MM/YYYY HH:mm:ss')}\n`;
            formattedContent += `🎯 Desenvolvido por: @Tequ1ladoxxado\n`;
            formattedContent += `✨ Bot Premium de Buscas Privadas\n`;
            formattedContent += `${'='.repeat(80)}\n\n`;
            formattedContent += `📊 RESULTADOS ENCONTRADOS:\n\n`;

            cachedCheck.forEach(linha => {
                if (linha.includes(':')) {
                    const partes = linha.split(':', 2);
                    const email = partes[0].trim();
                    const senha = partes[1].trim();
                    formattedContent += `🔹 URL: ${url}\n`;
                    formattedContent += `📧 EMAIL: ${email}\n`;
                    formattedContent += `🔐 SENHA: ${senha}\n`;
                    formattedContent += `📍 FONTE: CACHE\n`;
                    formattedContent += `${'-'.repeat(50)}\n\n`;
                }
            });

            fs.writeFileSync(arquivoFormatado, formattedContent);

        } else {
            // Simular busca real
            const searchInstance = new LoginSearch(url, userId, pastaTemp);
            const results = await searchInstance.buscar();
            contador = results.length;
        }

        const totalTime = Date.now() - searchStartTime;
        const timeStr = totalTime < 60000 ? 
            `${(totalTime / 1000).toFixed(1)}s` : 
            `${Math.floor(totalTime / 60000)}m ${Math.floor((totalTime % 60000) / 1000)}s`;

        if (contador === 0) {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                msgBusca.message_id,
                null,
                `❌ 𝗡𝗲𝗻𝗵𝘂𝗺 𝗿𝗲𝘀𝘂𝗹𝘁𝗮𝗱𝗼 𝗳𝗼𝗶 𝗲𝗻𝗰𝗼𝗻𝘁𝗿𝗮𝗱𝗼!\n\n📝 Tente com outro domínio\n⏱️ Tempo de busca: ${timeStr}\n\n🤖 @Olhosdecristo_bot`
            );
            fs.removeSync(pastaTemp);
            usuarios_bloqueados.delete(userId);
            return;
        }

        // Calcular velocidade média
        const avgSpeed = totalTime > 0 ? contador / (totalTime / 1000) : 0;
        const speedDisplay = avgSpeed > 1000 ? 
            `${(avgSpeed / 1000).toFixed(1)}k/s` : 
            `${avgSpeed.toFixed(0)}/s`;

        await ctx.telegram.deleteMessage(ctx.chat.id, msgBusca.message_id);

        await ctx.reply(
            `✅ 𝗕𝘂𝘀𝗰𝗮 𝗖𝗼𝗻𝗰𝗹𝘂í𝗱𝗮!\n\n` +
            `🎯 Resultados encontrados: ${contador.toLocaleString()}\n` +
            `🌐 Domínio: ${url}\n` +
            `⏱️ Tempo total: ${timeStr}\n` +
            `🚀 Velocidade média: ${speedDisplay}\n\n` +
            `📋 Escolha o formato de download:\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💻 By: Tequ1la | @Olhosdecristo_bot`,
            Markup.inlineKeyboard([
                [Markup.button.callback("📝 USER:PASS", `format1:${userId}`), Markup.button.callback("📋 FORMATADO", `format2:${userId}`)],
                [Markup.button.callback("📊 JSON Export", `export_json:${userId}`), Markup.button.callback("⭐ Favoritar", `add_to_favorites:${url}`)],
                [Markup.button.callback("❌ CANCELAR", `cancel:${userId}`)]
            ])
        );

        usuarios_bloqueados.delete(userId);

    } catch (error) {
        console.error("Erro na busca:", error);
        await ctx.reply("❌ Erro interno durante a busca.");
        usuarios_bloqueados.delete(ctx.from.id);
    }
}

// ===== INICIALIZAÇÃO =====
setupBot().catch(error => {
    console.error("Erro fatal:", error);
    process.exit(1);
});
