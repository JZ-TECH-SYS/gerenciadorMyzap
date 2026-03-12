(() => {
    const logFileSelect = document.getElementById('logFile');
    const logContent = document.getElementById('logContent');
    const logMeta = document.getElementById('logMeta');
    const searchInput = document.getElementById('search');
    const togglePollingButton = document.getElementById('togglePolling');
    const refreshNowButton = document.getElementById('refreshNow');
    const copyLogButton = document.getElementById('copyLog');
    const liveStatus = document.getElementById('liveStatus');
    const resultCount = document.getElementById('resultCount');
    const filterInputs = Array.from(document.querySelectorAll('.filters input'));

    let currentFile = '';
    let ticker = null;
    let isPollingPaused = false;
    let lastSnapshotKey = '';
    let lastVisibleLines = [];
    let refreshSequence = 0;
    let searchDebounceTimer = null;
    let copyFeedbackTimer = null;
    const LEVEL_CLASSES = ['error', 'warn', 'info', 'debug'];
    const POLL_INTERVAL_MS = 1500;
    const TOP_STICKY_TOLERANCE = 24;

    const escapeHtml = (value) =>
        String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

    const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const highlightText = (value, searchTerm) => {
        const text = String(value ?? '');
        if (!searchTerm) {
            return escapeHtml(text);
        }

        const matcher = new RegExp(`(${escapeRegExp(searchTerm)})`, 'ig');
        return text
            .split(matcher)
            .map((part) => (part.toLowerCase() === searchTerm.toLowerCase()
                ? `<mark>${escapeHtml(part)}</mark>`
                : escapeHtml(part)))
            .join('');
    };

    const formatMetadata = (metadata = {}) => {
        const result = { lines: [], content: '' };
        if (typeof metadata !== 'object' || !metadata) return result;

        Object.entries(metadata).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            if (key === 'conteudo' && typeof value === 'string') {
                result.content = value;
                return;
            }
            if (value instanceof Error) {
                result.lines.push(`${key}: ${value.message}`);
                return;
            }
            if (typeof value === 'object') {
                try {
                    result.lines.push(`${key}: ${JSON.stringify(value)}`);
                } catch {
                    result.lines.push(`${key}: [object]`);
                }
                return;
            }
            result.lines.push(`${key}: ${value}`);
        });

        return result;
    };

    const getActiveLevels = () => filterInputs
        .filter((input) => input.checked)
        .map((input) => input.value);

    const getSearchTerm = () => searchInput.value.trim();

    const updateResultCount = (total) => {
        const plural = total === 1 ? '' : 's';
        resultCount.textContent = `${total} registro${plural}`;
    };

    const updatePollingStateUi = () => {
        const paused = isPollingPaused || !currentFile;
        togglePollingButton.textContent = paused ? 'Retomar' : 'Pausar';
        liveStatus.textContent = paused ? 'Pausado' : 'Ao vivo';
        liveStatus.classList.toggle('paused', paused);
        togglePollingButton.disabled = !currentFile;
        refreshNowButton.disabled = !currentFile;
        copyLogButton.disabled = !currentFile || !lastVisibleLines.length;
    };

    const captureScrollState = () => ({
        scrollTop: logContent.scrollTop,
        scrollHeight: logContent.scrollHeight,
        shouldStickToTop: logContent.scrollTop <= TOP_STICKY_TOLERANCE
    });

    const restoreScrollState = (scrollState, preserveScroll) => {
        if (!scrollState) {
            logContent.scrollTop = 0;
            return;
        }

        if (!preserveScroll || scrollState.shouldStickToTop) {
            logContent.scrollTop = 0;
            return;
        }

        const heightDelta = logContent.scrollHeight - scrollState.scrollHeight;
        logContent.scrollTop = Math.max(0, scrollState.scrollTop + heightDelta);
    };

    const createLogLineElement = (line, searchTerm) => {
        const element = document.createElement('div');
        element.classList.add('log-line');

        let level = 'info';
        let timestamp = '';
        let message = line;
        let metadata = { lines: [], content: '' };

        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                level = (parsed.level || level).toLowerCase();
                timestamp = parsed.timestamp
                    ? new Date(parsed.timestamp).toLocaleString('pt-BR', { hour12: false })
                    : '';
                message = parsed.message || message;
                metadata = formatMetadata(parsed.metadata || {});
            } catch (error) {
                metadata.lines = ['Falha ao interpretar JSON: ' + error.message];
            }
        } else {
            const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
            if (match) {
                timestamp = match[1];
                const parsedLevel = match[2].toLowerCase();
                level = LEVEL_CLASSES.includes(parsedLevel) ? parsedLevel : level;
                message = match[3];
            }
        }

        if (!LEVEL_CLASSES.includes(level)) {
            level = 'info';
        }

        const metaHtml = metadata.lines.length
            ? `<div class="log-meta">${metadata.lines
                .map((metaLine) => `<span>${highlightText(metaLine, searchTerm)}</span>`)
                .join('<br>')}</div>`
            : '';
        const contentHtml = metadata.content
            ? `<pre class="log-content">${highlightText(metadata.content, searchTerm)}</pre>`
            : '';

        element.classList.add(level);
        element.innerHTML = `
            <div class="log-header">
                <span class="log-time">${escapeHtml(timestamp)}</span>
                <span class="log-level ${level}">${escapeHtml(level.toUpperCase())}</span>
            </div>
            <div class="log-message">${highlightText(message, searchTerm)}</div>
            ${metaHtml}
            ${contentHtml}
        `;

        return element;
    };

    const renderLogLines = (lines, options = {}) => {
        const scrollState = captureScrollState();
        const searchTerm = options.searchTerm || '';
        logContent.innerHTML = '';

        if (!lines.length) {
            logContent.textContent = 'Sem registros para mostrar.';
            logContent.scrollTop = 0;
            return;
        }

        const fragment = document.createDocumentFragment();
        const ordered = [...lines].reverse();
        ordered.forEach((line) => fragment.appendChild(createLogLineElement(line, searchTerm)));
        logContent.appendChild(fragment);
        restoreScrollState(scrollState, options.preserveScroll);
    };

    const buildSnapshotKey = ({ activeLevels, data, searchTerm }) => [
        currentFile,
        activeLevels.join(','),
        searchTerm.toLowerCase(),
        data.meta.size,
        data.meta.mtime,
        data.truncated,
        data.display.join('\u241E')
    ].join('|');

    async function refreshLog(options = {}) {
        if (!currentFile) return;

        const activeLevels = getActiveLevels();
        const searchTerm = getSearchTerm();
        const preserveScroll = !!options.preserveScroll;
        const requestId = refreshSequence + 1;
        refreshSequence = requestId;

        const data = await window.logViewer.readLogTail({
            filename: currentFile,
            levelFilters: activeLevels,
            search: searchTerm
        });

        if (requestId !== refreshSequence) {
            return;
        }

        lastVisibleLines = data.display;
        updateResultCount(data.display.length);

        const snapshotKey = buildSnapshotKey({ activeLevels, data, searchTerm });
        if (options.force || snapshotKey !== lastSnapshotKey) {
            renderLogLines(data.display, { preserveScroll, searchTerm });
            lastSnapshotKey = snapshotKey;
        }

        const updatedAt = new Date(data.meta.mtime).toLocaleString('pt-BR', { hour12: false });
        const truncado = data.truncated ? ' | exibindo a parte final do arquivo' : '';
        logMeta.textContent = `Arquivo: ${currentFile} | Tamanho: ${data.meta.size} bytes | Ultima gravacao: ${updatedAt}${truncado}`;
        updatePollingStateUi();
    }

    function startPolling() {
        if (ticker || isPollingPaused || !currentFile) {
            return;
        }

        ticker = setInterval(() => {
            refreshLog({ preserveScroll: true });
        }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
    }

    function setPollingPaused(nextState) {
        isPollingPaused = nextState;
        stopPolling();

        if (!isPollingPaused) {
            startPolling();
            refreshLog({ force: true, preserveScroll: true });
        } else {
            updatePollingStateUi();
        }
    }

    async function copyVisibleLog() {
        if (!lastVisibleLines.length) {
            return;
        }

        const orderedLines = [...lastVisibleLines].reverse();
        window.logViewer.copyText(orderedLines.join('\n'));

        copyLogButton.textContent = 'Copiado';
        clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = setTimeout(() => {
            copyLogButton.textContent = 'Copiar visivel';
        }, 1800);
    }

    async function populateFiles() {
        const arquivos = await window.logViewer.listLogFiles();
        logFileSelect.innerHTML = '';
        if (!arquivos.length) {
            const option = document.createElement('option');
            option.textContent = 'Sem arquivos disponiveis';
            logFileSelect.appendChild(option);
            currentFile = '';
            lastVisibleLines = [];
            logContent.textContent = 'Nao ha logs para exibir.';
            logMeta.textContent = '';
            updateResultCount(0);
            updatePollingStateUi();
            return;
        }

        arquivos
            .sort((a, b) => b.mtime - a.mtime)
            .forEach(({ name }) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                logFileSelect.appendChild(option);
            });

        currentFile = logFileSelect.value;
        lastSnapshotKey = '';
        await refreshLog({ force: true });
        startPolling();
        updatePollingStateUi();
    }

    logFileSelect.addEventListener('change', () => {
        currentFile = logFileSelect.value;
        lastSnapshotKey = '';
        refreshLog({ force: true });
    });

    filterInputs.forEach((input) => {
        input.addEventListener('change', () => {
            lastSnapshotKey = '';
            refreshLog({ force: true });
        });
    });

    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            lastSnapshotKey = '';
            refreshLog({ force: true });
        }, 180);
    });

    togglePollingButton.addEventListener('click', () => {
        setPollingPaused(!isPollingPaused);
    });

    refreshNowButton.addEventListener('click', () => {
        refreshLog({ force: true, preserveScroll: true });
    });

    copyLogButton.addEventListener('click', copyVisibleLog);

    window.addEventListener('beforeunload', () => {
        stopPolling();
        clearTimeout(searchDebounceTimer);
        clearTimeout(copyFeedbackTimer);
    });

    updateResultCount(0);
    updatePollingStateUi();
    populateFiles();
})();
