/*
 * Scribe Stack
 * Copyright (c) 2026 Jose AVILES
 * All rights reserved.
 */

// Notes Organizer - Main Application

// ========== SESSION & INDEXEDDB MANAGEMENT ==========

// Generate or retrieve session ID for this tab
const SESSION_ID = sessionStorage.getItem('sessionId') || (() => {
    const id = crypto.randomUUID();
    sessionStorage.setItem('sessionId', id);
    return id;
})();

// IndexedDB setup
const DB_NAME = 'NotesOrganizerDB';
const DB_VERSION = 1;
let db = null;

// Initialize IndexedDB
function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Store for session data (notes, notebook name, categories per session)
            if (!database.objectStoreNames.contains('sessions')) {
                database.createObjectStore('sessions', { keyPath: 'sessionId' });
            }
            
            // Store for global settings (theme, privacy - shared across tabs)
            if (!database.objectStoreNames.contains('settings')) {
                database.createObjectStore('settings', { keyPath: 'key' });
            }
        };
    });
}

// Save session data to IndexedDB
async function saveSessionData() {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['sessions'], 'readwrite');
        const store = transaction.objectStore('sessions');
        
        const sessionData = {
            sessionId: SESSION_ID,
            notes: notes,
            notebookName: notebookName,
            customCategories: customCategories,
            currentFileName: currentFileName,
            currentFilePath: currentFilePath,
            lastModifiedDate: lastModifiedDate,
            autosaveEnabled: autosaveEnabled,
            autosaveEncrypted: autosaveEncrypted,
            // Store encryption flag (password stored separately in sessionStorage for security)
            hasEncryptionPassword: !!sessionEncryptionPassword,
            updatedAt: new Date().toISOString()
        };
        
        const request = store.put(sessionData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Load session data from IndexedDB
async function loadSessionData() {
    if (!db) return null;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['sessions'], 'readonly');
        const store = transaction.objectStore('sessions');
        const request = store.get(SESSION_ID);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Clear session data from IndexedDB
async function clearSessionData() {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['sessions'], 'readwrite');
        const store = transaction.objectStore('sessions');
        const request = store.delete(SESSION_ID);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Save global setting to IndexedDB
async function saveGlobalSetting(key, value) {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['settings'], 'readwrite');
        const store = transaction.objectStore('settings');
        const request = store.put({ key, value });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Load global setting from IndexedDB
async function loadGlobalSetting(key) {
    if (!db) return null;
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['settings'], 'readonly');
        const store = transaction.objectStore('settings');
        const request = store.get(key);
        
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
    });
}

// ========== DATA STORE ==========

// Data Store
let notes = [];
let currentEditId = null;
let notebookName = 'My Notebook';
let currentTheme = 'light';
let sessionEncryptionPassword = null; // Stores password from encrypted import for reuse during export
let customCategories = []; // User-defined categories

// Autosave state
let autosaveEnabled = false; // Becomes true after first save or import
let autosaveEncrypted = false; // Whether autosave uses encryption
let fileHandle = null; // File System Access API handle for saving to same location
let autosaveTimeout = null; // Debounce timer for autosave

// File info state
let currentFileName = null; // Name of the currently opened file
let currentFilePath = null; // Path of the currently opened file (if available)
let lastModifiedDate = null; // Last save/modification timestamp

// ========== ENCRYPTION STATE PERSISTENCE ==========

// Save encryption state to sessionStorage (survives tab hibernation)
function persistEncryptionState() {
    try {
        const encryptionState = {
            autosaveEncrypted: autosaveEncrypted,
            hasPassword: !!sessionEncryptionPassword,
            // Store password in sessionStorage (secure for this session only)
            password: sessionEncryptionPassword || null,
            autosaveEnabled: autosaveEnabled,
            currentFileName: currentFileName,
            timestamp: Date.now()
        };
        sessionStorage.setItem('encryptionState', JSON.stringify(encryptionState));
    } catch (e) {
        console.warn('Could not persist encryption state:', e);
    }
}

// Restore encryption state from sessionStorage
function restoreEncryptionState() {
    try {
        const stored = sessionStorage.getItem('encryptionState');
        if (stored) {
            const state = JSON.parse(stored);
            // Only restore if the state is recent (within 24 hours)
            if (state.timestamp && (Date.now() - state.timestamp) < 24 * 60 * 60 * 1000) {
                // Restore password if we lost it but had one
                if (!sessionEncryptionPassword && state.password) {
                    sessionEncryptionPassword = state.password;
                }
                // Restore encryption flag if needed
                if (state.autosaveEncrypted && !autosaveEncrypted) {
                    autosaveEncrypted = state.autosaveEncrypted;
                }
                return true;
            }
        }
    } catch (e) {
        console.warn('Could not restore encryption state:', e);
    }
    return false;
}

// Validate file state before save - ensures encryption settings are consistent
async function validateFileState() {
    // Try to restore from sessionStorage first
    restoreEncryptionState();
    
    // Check if we should be encrypted but lost the password
    if (autosaveEncrypted && !sessionEncryptionPassword) {
        // Try to get password from user
        const password = await showPrompt(
            'Your file is encrypted but the password was lost.\nPlease re-enter your encryption password to continue saving:',
            '🔑 Re-enter Password',
            { inputType: 'password', placeholder: 'Enter encryption password' }
        );
        
        if (password) {
            sessionEncryptionPassword = password;
            persistEncryptionState();
            return true;
        } else {
            // User cancelled - ask if they want to save unencrypted
            const saveUnencrypted = await showConfirm(
                'No password provided. Would you like to save without encryption instead?\n\n⚠️ Your data will be saved as plain JSON.',
                '⚠️ Save Without Encryption?'
            );
            if (saveUnencrypted) {
                autosaveEncrypted = false;
                persistEncryptionState();
                return true;
            }
            return false; // Cancel save
        }
    }
    
    return true;
}

// Handle tab visibility changes (restore state when tab wakes from sleep)
function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Tab became visible - restore encryption state if needed
            restoreEncryptionState();
        } else {
            // Tab is being hidden - persist current state
            persistEncryptionState();
        }
    });
    
    // Also persist before page unload
    window.addEventListener('beforeunload', () => {
        persistEncryptionState();
    });
}

// ========== ATTACHMENTS & CATEGORIES ==========

// Attachment state
let currentAttachments = []; // Attachments for the current note being edited
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total

// Default categories (cannot be deleted)
const DEFAULT_CATEGORIES = [
    { value: 'personal', label: 'Personal' },
    { value: 'work', label: 'Work' },
    { value: 'ideas', label: 'Ideas' },
    { value: 'learning', label: 'Learning' },
    { value: 'action', label: 'Action' },
    { value: 'archive', label: 'Archive' },
    { value: 'private', label: 'Private', encryptedOnly: true, parentCategory: 'archive' }
];

// State for private category access
let privateAccessGranted = false; // Reset each time user selects private category

// Check if a category has action controls (status, progress, due date)
// Action category and all custom categories have these controls
function hasActionControls(category) {
    if (category === 'action') return true;
    // Check if it's a custom category
    const customCatValues = customCategories.map(cat => cat.toLowerCase().replace(/\s+/g, '-'));
    return customCatValues.includes(category);
}

// Rating order for sorting (higher is better)
const ratingOrder = { 5: 1, 4: 2, 3: 3, 2: 4, 1: 5 };
const statusOrder = { 'not-started': 1, 'in-progress': 2, 'completed': 3, 'deferred': 4, 'cancelled': 5 };

// DOM Elements
const notesContainer = document.getElementById('requirementsContainer');
const noteModal = document.getElementById('requirementModal');
const viewModal = document.getElementById('viewModal');
const noteForm = document.getElementById('requirementForm');

// ========== CUSTOM DIALOG SYSTEM ==========
const customDialog = {
    modal: null,
    titleEl: null,
    messageEl: null,
    inputContainer: null,
    inputEl: null,
    okBtn: null,
    cancelBtn: null,
    closeBtn: null,
    resolvePromise: null,
    
    init() {
        this.modal = document.getElementById('customDialog');
        this.titleEl = document.getElementById('dialogTitle');
        this.messageEl = document.getElementById('dialogMessage');
        this.inputContainer = document.getElementById('dialogInputContainer');
        this.inputEl = document.getElementById('dialogInput');
        this.okBtn = document.getElementById('dialogOkBtn');
        this.cancelBtn = document.getElementById('dialogCancelBtn');
        this.closeBtn = document.getElementById('closeDialog');
        
        this.okBtn.addEventListener('click', () => this.handleOk());
        this.cancelBtn.addEventListener('click', () => this.handleCancel());
        this.closeBtn.addEventListener('click', () => this.handleCancel());
        
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.handleOk();
            if (e.key === 'Escape') this.handleCancel();
        });
        
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.handleCancel();
        });
    },
    
    show(options) {
        const { title, message, input, inputType, placeholder, okText, cancelText, alertMode } = options;
        
        this.titleEl.textContent = title || 'Dialog';
        this.messageEl.textContent = message || '';
        this.okBtn.textContent = okText || 'OK';
        this.cancelBtn.textContent = cancelText || 'Cancel';
        
        if (input) {
            this.inputContainer.style.display = 'block';
            this.inputEl.type = inputType || 'text';
            this.inputEl.placeholder = placeholder || '';
            this.inputEl.value = '';
        } else {
            this.inputContainer.style.display = 'none';
        }
        
        if (alertMode) {
            this.modal.classList.add('alert-mode');
        } else {
            this.modal.classList.remove('alert-mode');
        }
        
        this.modal.classList.add('active');
        
        if (input) {
            setTimeout(() => this.inputEl.focus(), 100);
        } else {
            setTimeout(() => this.okBtn.focus(), 100);
        }
        
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    },
    
    hide() {
        this.modal.classList.remove('active');
        this.modal.classList.remove('alert-mode');
    },
    
    handleOk() {
        const value = this.inputContainer.style.display !== 'none' ? this.inputEl.value : true;
        this.hide();
        if (this.resolvePromise) this.resolvePromise(value);
    },
    
    handleCancel() {
        this.hide();
        if (this.resolvePromise) this.resolvePromise(null);
    }
};

// Custom alert, confirm, prompt functions
async function showAlert(message, title = '📢 Notice') {
    return customDialog.show({
        title,
        message,
        alertMode: true,
        okText: 'OK'
    });
}

async function showConfirm(message, title = '❓ Confirm') {
    const result = await customDialog.show({
        title,
        message,
        okText: 'Yes',
        cancelText: 'No'
    });
    return result === true;
}

async function showPrompt(message, title = '✏️ Input', options = {}) {
    return customDialog.show({
        title,
        message,
        input: true,
        inputType: options.inputType || 'text',
        placeholder: options.placeholder || '',
        okText: options.okText || 'OK',
        cancelText: options.cancelText || 'Cancel'
    });
}

// ========== QUILL EDITOR ==========
let quillEditor = null;
let quillAutoSaveTimeout = null;

function initQuillEditor() {
    if (quillEditor) return; // Already initialized
    
    quillEditor = new Quill('#quillEditor', {
        theme: 'snow',
        placeholder: 'Write your note content here...',
        modules: {
            toolbar: {
                container: [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ 'color': [] }, { 'background': [] }],
                    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                    ['blockquote', 'code-block'],
                    ['link', 'image'],
                    ['clean']
                ],
                handlers: {
                    'image': imageHandler
                }
            }
        }
    });
    
    // Auto-save on text change (debounced)
    quillEditor.on('text-change', function() {
        if (quillAutoSaveTimeout) clearTimeout(quillAutoSaveTimeout);
        quillAutoSaveTimeout = setTimeout(autoSaveNote, 500);
    });
    
    // Handle paste with images
    quillEditor.root.addEventListener('paste', handleImagePaste);
}

// Image handler for toolbar button
function imageHandler() {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/*');
    input.click();
    
    input.onchange = async () => {
        const file = input.files[0];
        if (file) {
            const base64 = await compressAndConvertImage(file);
            insertImageToQuill(base64);
        }
    };
}

// Handle pasting images from clipboard
async function handleImagePaste(e) {
    const clipboardData = e.clipboardData;
    if (!clipboardData || !clipboardData.items) return;
    
    for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault();
            const file = item.getAsFile();
            const base64 = await compressAndConvertImage(file);
            insertImageToQuill(base64);
            break;
        }
    }
}

// Compress and convert image to base64
function compressAndConvertImage(file, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                
                // Resize if larger than maxWidth
                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to base64 with compression
                const base64 = canvas.toDataURL('image/jpeg', quality);
                resolve(base64);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// Insert image into Quill editor
function insertImageToQuill(base64) {
    const range = quillEditor.getSelection(true);
    quillEditor.insertEmbed(range.index, 'image', base64);
    quillEditor.setSelection(range.index + 1);
}

function getQuillContent() {
    if (!quillEditor) return '';
    return quillEditor.root.innerHTML;
}

function setQuillContent(html) {
    if (!quillEditor) return;
    if (html) {
        quillEditor.root.innerHTML = html;
    } else {
        quillEditor.setText('');
    }
}

function isQuillEmpty() {
    if (!quillEditor) return true;
    const text = quillEditor.getText().trim();
    return text.length === 0;
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize IndexedDB first
    try {
        await initDatabase();
    } catch (error) {
        console.error('Failed to initialize IndexedDB:', error);
    }
    
    customDialog.init();
    initQuillEditor();
    await loadFromStorage();
    await loadTheme();
    loadNotebookNameFromState();
    populateCategoryDropdowns();
    populateStatusFilter();
    renderNotes();
    updateStats();
    checkDueSoon();
    setupEventListeners();
    setupStarRating();
    setupVisibilityHandler(); // Handle tab sleep/wake for encryption state
    updateFileInfoDisplay(); // Initialize file info display
});

// Event Listeners Setup
function setupEventListeners() {
    // Theme Toggle
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    
    // Privacy Toggle
    document.getElementById('privacyToggle')?.addEventListener('click', enablePrivacyMode);
    loadPrivacyMode();
    
    // Notebook Name
    const notebookNameInput = document.getElementById('projectName');
    notebookNameInput.addEventListener('input', debounce(saveNotebookName, 500));
    notebookNameInput.addEventListener('blur', saveNotebookName);
    
    // Add Note Button
    document.getElementById('addRequirementBtn').addEventListener('click', () => openModal());
    
    // Export Button
    document.getElementById('exportBtn').addEventListener('click', exportToJSON);
    
    // Import Button - use File System Access API if available
    document.getElementById('importBtn').addEventListener('click', openFile);
    // Fallback file input for browsers without File System Access API
    document.getElementById('importFile').addEventListener('change', importFromJSON);
    
    // Print Button
    document.getElementById('printBtn').addEventListener('click', printToPDF);
    
    // Help Button
    document.getElementById('helpBtn').addEventListener('click', openHelpModal);
    document.getElementById('closeHelpModal').addEventListener('click', closeHelpModal);
    document.getElementById('closeHelpBtn').addEventListener('click', closeHelpModal);
    
    // Encryption Settings Button
    document.getElementById('encryptionSettingsBtn')?.addEventListener('click', changeEncryptionSetting);
    
    // Category Management
    document.getElementById('manageCategoriesBtn')?.addEventListener('click', showCategoryManagement);
    document.getElementById('closeCategoryModal')?.addEventListener('click', closeCategoryManagement);
    document.getElementById('closeCategoryBtn')?.addEventListener('click', closeCategoryManagement);
    document.getElementById('addCategoryBtn')?.addEventListener('click', addCustomCategory);
    
    // Link Notes Modal
    document.getElementById('openLinkNotesBtn')?.addEventListener('click', openLinkNotesModal);
    document.getElementById('closeLinkNotesModal')?.addEventListener('click', closeLinkNotesModal);
    document.getElementById('confirmLinkNotesBtn')?.addEventListener('click', confirmLinkNotes);
    document.getElementById('linkNotesSearch')?.addEventListener('input', (e) => filterLinkNotes(e.target.value));
    
    // Attachment handling
    document.getElementById('addAttachmentBtn')?.addEventListener('click', () => {
        document.getElementById('attachmentInput').click();
    });
    document.getElementById('attachmentInput')?.addEventListener('change', handleAttachmentSelect);
    
    // New Notebook Button
    document.getElementById('newProjectBtn')?.addEventListener('click', startNewNotebook);
    
    // Mobile Sidebar Action Buttons
    document.getElementById('importBtnMobile')?.addEventListener('click', () => {
        openFile();
        closeSidebar();
    });
    document.getElementById('exportBtnMobile')?.addEventListener('click', () => {
        exportToJSON();
        closeSidebar();
    });
    document.getElementById('printBtnMobile')?.addEventListener('click', () => {
        printToPDF();
        closeSidebar();
    });
    document.getElementById('newProjectBtnMobile')?.addEventListener('click', () => {
        closeSidebar();
        startNewNotebook();
    });
    
    // Sidebar Toggle (Mobile)
    document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebar);
    document.getElementById('closeSidebar')?.addEventListener('click', closeSidebar);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeSidebar);
    
    // Stats Carousel Tabs
    document.querySelectorAll('.stats-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            // Update active tab
            document.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Update active panel
            document.querySelectorAll('.stats-panel').forEach(p => p.classList.remove('active'));
            const panel = document.getElementById(`panel-${tabName}`);
            if (panel) panel.classList.add('active');
        });
    });
    
    // Due Soon Banner
    document.getElementById('showDueSoonBtn')?.addEventListener('click', showDueSoonItems);
    document.getElementById('dismissDueSoonBtn')?.addEventListener('click', dismissDueSoon);
    
    // Modal Controls
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelBtn').addEventListener('click', closeModal);
    document.getElementById('closeViewModal').addEventListener('click', closeViewModal);
    document.getElementById('closeViewBtn').addEventListener('click', closeViewModal);
    document.getElementById('printFromViewBtn').addEventListener('click', printFromView);
    document.getElementById('editFromViewBtn').addEventListener('click', editFromView);
    
    // Form Submit
    noteForm.addEventListener('submit', handleFormSubmit);
    
    // Auto-save on input change (debounced) - Note: Quill handles its own auto-save
    const autoSaveFields = ['reqTitle', 'reqCategory', 'reqStatus', 'reqDueDate', 'reqProgress', 'reqProgressSlider', 'reqLinked', 'reqNotes'];
    autoSaveFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('input', debounce(autoSaveNote, 500));
            field.addEventListener('change', debounce(autoSaveNote, 300));
        }
    });
    
    // Category change - show/hide status for action notes and custom categories
    document.getElementById('reqCategory').addEventListener('change', (e) => {
        const statusRow = document.getElementById('statusRow');
        const actionDetailsRow = document.getElementById('actionDetailsRow');
        if (hasActionControls(e.target.value)) {
            statusRow.style.display = 'block';
            actionDetailsRow.style.display = 'grid';
        } else {
            statusRow.style.display = 'none';
            actionDetailsRow.style.display = 'none';
        }
        autoSaveNote(); // Auto-save on category change
    });
    
    // Progress slider and number input sync
    document.getElementById('reqProgressSlider').addEventListener('input', (e) => {
        document.getElementById('reqProgress').value = e.target.value;
    });
    document.getElementById('reqProgress').addEventListener('input', (e) => {
        let val = parseInt(e.target.value) || 0;
        val = Math.max(0, Math.min(100, val));
        e.target.value = val;
        document.getElementById('reqProgressSlider').value = val;
    });
    
    // Auto-set progress when status changes
    document.getElementById('reqStatus').addEventListener('change', (e) => {
        if (e.target.value === 'completed') {
            document.getElementById('reqProgress').value = 100;
            document.getElementById('reqProgressSlider').value = 100;
        } else if (e.target.value === 'not-started') {
            document.getElementById('reqProgress').value = 0;
            document.getElementById('reqProgressSlider').value = 0;
        }
        autoSaveNote(); // Auto-save on status change
    });
    
    // Filters
    document.getElementById('filterCategory').addEventListener('change', handleCategoryFilterChange);
    document.getElementById('filterPriority').addEventListener('change', renderNotes);
    document.getElementById('filterStatus').addEventListener('change', renderNotes);
    document.getElementById('clearFilters').addEventListener('click', clearFilters);
    
    // Search
    document.getElementById('searchInput').addEventListener('input', debounce(renderNotes, 300));
    
    // Sort
    document.getElementById('sortBy').addEventListener('change', renderNotes);
    
    // Close modals on outside click
    noteModal.addEventListener('click', (e) => {
        if (e.target === noteModal) closeModal();
    });
    viewModal.addEventListener('click', (e) => {
        if (e.target === viewModal) closeViewModal();
    });
    document.getElementById('helpModal').addEventListener('click', (e) => {
        if (e.target.id === 'helpModal') closeHelpModal();
    });
}

// Star Rating Input Setup
function setupStarRating() {
    const starContainer = document.getElementById('starRatingInput');
    const stars = starContainer.querySelectorAll('.star');
    const ratingInput = document.getElementById('reqPriority');
    
    // Set initial rating
    updateStarDisplay(parseInt(ratingInput.value) || 3);
    
    stars.forEach(star => {
        star.addEventListener('click', () => {
            const rating = parseInt(star.dataset.rating);
            ratingInput.value = rating;
            updateStarDisplay(rating);
            autoSaveNote(); // Auto-save on rating change
        });
        
        star.addEventListener('mouseover', () => {
            const rating = parseInt(star.dataset.rating);
            highlightStars(rating);
        });
        
        star.addEventListener('mouseout', () => {
            updateStarDisplay(parseInt(ratingInput.value) || 3);
        });
    });
}

function updateStarDisplay(rating) {
    const stars = document.querySelectorAll('#starRatingInput .star');
    stars.forEach(star => {
        const starRating = parseInt(star.dataset.rating);
        if (starRating <= rating) {
            star.classList.add('active');
        } else {
            star.classList.remove('active');
        }
    });
}

function highlightStars(rating) {
    const stars = document.querySelectorAll('#starRatingInput .star');
    stars.forEach(star => {
        const starRating = parseInt(star.dataset.rating);
        if (starRating <= rating) {
            star.classList.add('hover');
        } else {
            star.classList.remove('hover');
        }
    });
}

// Generate unique ID - simple sequential numbering
function generateId() {
    const prefix = 'NOTE';
    let maxNum = 0;
    
    notes.forEach(note => {
        const match = note.id.match(/^NOTE-(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
        }
    });
    
    const nextNum = maxNum + 1;
    return `${prefix}-${String(nextNum).padStart(3, '0')}`;
}

// Open Modal for Add/Edit
function openModal(id = null) {
    currentEditId = id;
    const modalTitle = document.getElementById('modalTitle');
    
    if (id) {
        // Edit mode
        modalTitle.textContent = 'Edit Note';
        const note = notes.find(n => n.id === id);
        if (note) {
            document.getElementById('reqId').value = note.id;
            document.getElementById('reqTitle').value = note.title;
            setQuillContent(note.description);
            document.getElementById('reqCategory').value = note.category;
            document.getElementById('reqPriority').value = note.rating;
            document.getElementById('reqStatus').value = note.status || 'not-started';
            document.getElementById('reqNotes').value = note.notes || '';
            
            // Update star display
            updateStarDisplay(note.rating);
            
            // Show/hide status and action details based on category
            const statusRow = document.getElementById('statusRow');
            const actionDetailsRow = document.getElementById('actionDetailsRow');
            if (hasActionControls(note.category)) {
                statusRow.style.display = 'block';
                actionDetailsRow.style.display = 'grid';
                document.getElementById('reqDueDate').value = note.dueDate || '';
                document.getElementById('reqProgress').value = note.progress || 0;
                document.getElementById('reqProgressSlider').value = note.progress || 0;
            } else {
                statusRow.style.display = 'none';
                actionDetailsRow.style.display = 'none';
            }
            
            // Set linked notes
            document.getElementById('reqLinked').value = (note.linkedNotes || []).join(',');
            updateLinkedNotesPreview();
            
            // Load attachments
            currentAttachments = note.attachments ? [...note.attachments] : [];
            renderAttachmentList();
        }
    } else {
        // Add mode - create a new note immediately
        const newId = generateId();
        currentEditId = newId;
        
        modalTitle.textContent = 'Add New Note';
        noteForm.reset();
        document.getElementById('reqId').value = newId;
        document.getElementById('reqCategory').value = 'personal';
        document.getElementById('reqPriority').value = '3';
        document.getElementById('reqStatus').value = 'not-started';
        document.getElementById('statusRow').style.display = 'none';
        document.getElementById('actionDetailsRow').style.display = 'none';
        document.getElementById('reqDueDate').value = '';
        document.getElementById('reqProgress').value = 0;
        document.getElementById('reqProgressSlider').value = 0;
        
        // Reset star display
        updateStarDisplay(3);
        
        // Clear Quill editor
        setQuillContent('');
        
        // Clear linked notes
        document.getElementById('reqLinked').value = '';
        updateLinkedNotesPreview();
        
        // Clear attachments
        currentAttachments = [];
        renderAttachmentList();
        
        // Create the note immediately with defaults
        const noteData = {
            id: newId,
            title: '',
            description: '',
            category: 'personal',
            rating: 3,
            status: null,
            dueDate: null,
            progress: null,
            linkedNotes: [],
            attachments: [],
            notes: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        notes.push(noteData);
        saveToStorage();
        triggerAutosave();
        renderNotes();
        updateStats();
    }
    
    noteModal.classList.add('active');
    
    // Focus on Quill editor after modal opens
    setTimeout(() => {
        if (quillEditor) quillEditor.focus();
    }, 100);
}

// Auto-save note as user types
function autoSaveNote() {
    if (!currentEditId) return;
    
    const linkedInput = document.getElementById('reqLinked');
    const linkedNotes = linkedInput.value ? linkedInput.value.split(',').filter(Boolean) : [];
    
    const categoryValue = document.getElementById('reqCategory').value || 'personal';
    const ratingValue = parseInt(document.getElementById('reqPriority').value) || 3;
    const statusValue = document.getElementById('reqStatus').value || 'not-started';
    const dueDateValue = document.getElementById('reqDueDate').value || null;
    const progressValue = parseInt(document.getElementById('reqProgress').value) || 0;
    
    const existingNote = notes.find(n => n.id === currentEditId);
    
    const noteData = {
        id: currentEditId,
        title: document.getElementById('reqTitle').value.trim(),
        description: getQuillContent(),
        category: categoryValue,
        rating: ratingValue,
        status: hasActionControls(categoryValue) ? statusValue : null,
        dueDate: hasActionControls(categoryValue) ? dueDateValue : null,
        progress: hasActionControls(categoryValue) ? progressValue : null,
        linkedNotes: linkedNotes,
        attachments: currentAttachments,
        notes: document.getElementById('reqNotes').value.trim(),
        createdAt: existingNote?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    const index = notes.findIndex(n => n.id === currentEditId);
    if (index !== -1) {
        notes[index] = noteData;
    }
    
    saveToStorage();
    triggerAutosave();
    renderNotes();
    updateStats();
    checkDueSoon();
}

// Close Modal
function closeModal() {
    // If there's a current note being edited, check if it's empty and should be deleted
    if (currentEditId) {
        const note = notes.find(n => n.id === currentEditId);
        if (note && !note.title.trim() && isQuillEmpty()) {
            // Delete empty notes
            notes = notes.filter(n => n.id !== currentEditId);
            saveToStorage();
            triggerAutosave();
            renderNotes();
            updateStats();
        }
    }
    
    noteModal.classList.remove('active');
    noteForm.reset();
    setQuillContent('');
    currentEditId = null;
}

// ========== INLINE EDIT MODE ==========
// To revert to modal editing: change openInlineEdit('${note.id}') back to openModal('${note.id}') in createNoteCard()

let inlineQuillEditor = null;
let inlineEditingId = null;
let inlineAttachments = [];

// Open inline edit mode on a card
function openInlineEdit(noteId) {
    // Close any existing inline edit first
    if (inlineEditingId && inlineEditingId !== noteId) {
        closeInlineEdit(false);
    }
    
    const note = notes.find(n => n.id === noteId);
    if (!note) return;
    
    inlineEditingId = noteId;
    inlineAttachments = note.attachments ? [...note.attachments] : [];
    
    const card = document.querySelector(`.requirement-card[data-id="${noteId}"]`);
    if (!card) return;
    
    // Expand the card first
    card.classList.add('expanded');
    card.classList.add('inline-editing');
    
    // Store original card body content for cancel
    const cardBody = card.querySelector('.card-body');
    card.dataset.originalBody = cardBody.innerHTML;
    
    // Generate category options
    const categoryOptions = getAllCategories().map(cat => 
        `<option value="${cat.value}" ${note.category === cat.value ? 'selected' : ''}>${cat.label}</option>`
    ).join('');
    
    // Generate status options
    const statusOptions = `
        <option value="not-started" ${note.status === 'not-started' ? 'selected' : ''}>Not Started</option>
        <option value="in-progress" ${note.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
        <option value="completed" ${note.status === 'completed' ? 'selected' : ''}>Completed</option>
        <option value="deferred" ${note.status === 'deferred' ? 'selected' : ''}>Deferred</option>
        <option value="cancelled" ${note.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
    `;
    
    // Replace card body with edit form
    cardBody.innerHTML = `
        <div class="inline-edit-form">
            <div class="inline-edit-row">
                <div class="inline-edit-group inline-edit-title">
                    <label>Title</label>
                    <input type="text" id="inlineTitle" value="${escapeHtml(note.title)}" placeholder="Enter note title">
                </div>
                <div class="inline-edit-group inline-edit-rating">
                    <label>Rating</label>
                    <div class="star-rating-input" id="inlineStarRating">
                        ${[1,2,3,4,5].map(i => `<span class="star ${i <= note.rating ? 'active' : ''}" data-rating="${i}">★</span>`).join('')}
                    </div>
                    <input type="hidden" id="inlineRating" value="${note.rating}">
                </div>
            </div>
            
            <div class="inline-edit-row inline-meta-row">
                <div class="inline-edit-group inline-edit-category">
                    <label>Category</label>
                    <select id="inlineCategory">${categoryOptions}</select>
                </div>
                <div class="inline-edit-group inline-edit-status" id="inlineStatusGroup" style="${hasActionControls(note.category) ? '' : 'display:none'}">
                    <label>Status</label>
                    <select id="inlineStatus">${statusOptions}</select>
                </div>
                <div class="inline-edit-group inline-edit-due" id="inlineDueDateGroup" style="${hasActionControls(note.category) ? '' : 'display:none'}">
                    <label>Due Date</label>
                    <input type="date" id="inlineDueDate" value="${note.dueDate || ''}">
                </div>
                <div class="inline-edit-group inline-edit-progress" id="inlineProgressGroup" style="${hasActionControls(note.category) ? '' : 'display:none'}">
                    <label>Progress</label>
                    <div class="progress-input-container">
                        <input type="range" id="inlineProgressSlider" min="0" max="100" value="${note.progress || 0}" class="progress-slider">
                        <input type="number" id="inlineProgress" min="0" max="100" value="${note.progress || 0}" class="progress-number">
                        <span class="progress-percent">%</span>
                    </div>
                </div>
            </div>
            
            <div class="inline-edit-group">
                <label>Content</label>
                <div id="inlineQuillEditor" class="inline-quill-container"></div>
            </div>
            
            <details class="inline-edit-advanced">
                <summary>More Options</summary>
                <div class="inline-edit-advanced-content">
                    <div class="inline-edit-group">
                        <label>Attachments</label>
                        <div class="attachment-container">
                            <input type="file" id="inlineAttachmentInput" multiple style="display: none;">
                            <button type="button" id="inlineAddAttachmentBtn" class="btn btn-secondary btn-sm">📎 Add Files</button>
                            <div id="inlineAttachmentList" class="attachment-list"></div>
                        </div>
                    </div>
                    
                    <div class="inline-edit-group">
                        <label>Linked Notes</label>
                        <div class="linked-notes-display">
                            <div id="inlineLinkedNotesPreview" class="linked-notes-preview">No linked notes</div>
                            <button type="button" id="inlineOpenLinkNotesBtn" class="btn btn-secondary btn-sm">Manage Links</button>
                        </div>
                        <input type="hidden" id="inlineLinked" value="${(note.linkedNotes || []).join(',')}">
                    </div>
                    
                    <div class="inline-edit-group">
                        <label>Additional Notes</label>
                        <textarea id="inlineNotes" rows="2" placeholder="Any additional notes or tags">${escapeHtml(note.notes || '')}</textarea>
                    </div>
                </div>
            </details>
            
            <div class="inline-edit-actions">
                <button type="button" class="btn btn-secondary" onclick="closeInlineEdit(false)">Cancel</button>
                <button type="button" class="btn btn-primary" onclick="saveInlineEdit()">Done</button>
            </div>
        </div>
    `;
    
    // Initialize inline Quill editor
    inlineQuillEditor = new Quill('#inlineQuillEditor', {
        theme: 'snow',
        placeholder: 'Enter note content...',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'color': [] }, { 'background': [] }],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                ['code-block', 'link', 'image'],
                ['clean']
            ]
        }
    });
    
    // Set content
    if (note.description) {
        inlineQuillEditor.root.innerHTML = note.description;
    }
    
    // Add image handler
    inlineQuillEditor.getModule('toolbar').addHandler('image', inlineImageHandler);
    inlineQuillEditor.root.addEventListener('paste', handleInlineImagePaste);
    
    // Setup star rating
    setupInlineStarRating();
    
    // Setup category change handler
    document.getElementById('inlineCategory').addEventListener('change', (e) => {
        const statusGroup = document.getElementById('inlineStatusGroup');
        const dueDateGroup = document.getElementById('inlineDueDateGroup');
        const progressGroup = document.getElementById('inlineProgressGroup');
        if (hasActionControls(e.target.value)) {
            statusGroup.style.display = '';
            dueDateGroup.style.display = '';
            progressGroup.style.display = '';
        } else {
            statusGroup.style.display = 'none';
            dueDateGroup.style.display = 'none';
            progressGroup.style.display = 'none';
        }
    });
    
    // Setup progress slider sync
    const progressSlider = document.getElementById('inlineProgressSlider');
    const progressNumber = document.getElementById('inlineProgress');
    if (progressSlider && progressNumber) {
        progressSlider.addEventListener('input', () => progressNumber.value = progressSlider.value);
        progressNumber.addEventListener('input', () => progressSlider.value = progressNumber.value);
    }
    
    // Setup attachments
    renderInlineAttachments();
    document.getElementById('inlineAddAttachmentBtn').addEventListener('click', () => {
        document.getElementById('inlineAttachmentInput').click();
    });
    document.getElementById('inlineAttachmentInput').addEventListener('change', handleInlineAttachmentAdd);
    
    // Setup linked notes
    updateInlineLinkedNotesPreview();
    document.getElementById('inlineOpenLinkNotesBtn').addEventListener('click', () => {
        openInlineLinkNotesModal();
    });
    
    // Focus on title
    setTimeout(() => {
        document.getElementById('inlineTitle').focus();
    }, 100);
    
    // Prevent card click from collapsing
    card.onclick = (e) => e.stopPropagation();
}

// Setup star rating for inline edit
function setupInlineStarRating() {
    const container = document.getElementById('inlineStarRating');
    const ratingInput = document.getElementById('inlineRating');
    const stars = container.querySelectorAll('.star');
    
    stars.forEach(star => {
        star.addEventListener('click', () => {
            const rating = parseInt(star.dataset.rating);
            ratingInput.value = rating;
            updateInlineStarDisplay(rating);
        });
        star.addEventListener('mouseover', () => {
            highlightInlineStars(parseInt(star.dataset.rating));
        });
        star.addEventListener('mouseout', () => {
            updateInlineStarDisplay(parseInt(ratingInput.value));
        });
    });
}

function updateInlineStarDisplay(rating) {
    const stars = document.querySelectorAll('#inlineStarRating .star');
    stars.forEach(star => {
        const starRating = parseInt(star.dataset.rating);
        star.classList.toggle('active', starRating <= rating);
    });
}

function highlightInlineStars(rating) {
    const stars = document.querySelectorAll('#inlineStarRating .star');
    stars.forEach(star => {
        const starRating = parseInt(star.dataset.rating);
        star.classList.toggle('hover', starRating <= rating);
    });
}

// Image handler for inline editor
function inlineImageHandler() {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/*');
    input.click();
    
    input.onchange = async () => {
        const file = input.files[0];
        if (file) {
            const base64 = await compressAndConvertImage(file);
            const range = inlineQuillEditor.getSelection(true);
            inlineQuillEditor.insertEmbed(range.index, 'image', base64);
            inlineQuillEditor.setSelection(range.index + 1);
        }
    };
}

// Handle paste for inline editor
async function handleInlineImagePaste(e) {
    const clipboardData = e.clipboardData;
    if (!clipboardData || !clipboardData.items) return;
    
    for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault();
            const file = item.getAsFile();
            const base64 = await compressAndConvertImage(file);
            const range = inlineQuillEditor.getSelection(true);
            inlineQuillEditor.insertEmbed(range.index, 'image', base64);
            inlineQuillEditor.setSelection(range.index + 1);
            break;
        }
    }
}

// Render inline attachments
function renderInlineAttachments() {
    const list = document.getElementById('inlineAttachmentList');
    if (!list) return;
    
    if (inlineAttachments.length === 0) {
        list.innerHTML = '<span class="no-attachments">No attachments</span>';
        return;
    }
    
    list.innerHTML = inlineAttachments.map((att, idx) => `
        <div class="attachment-item">
            <span class="attachment-name" title="${att.name}">${att.name}</span>
            <span class="attachment-size">(${formatFileSize(att.size)})</span>
            <button type="button" class="attachment-remove" onclick="removeInlineAttachment(${idx})">✕</button>
        </div>
    `).join('');
}

// Handle attachment add
async function handleInlineAttachmentAdd(e) {
    const files = Array.from(e.target.files);
    
    for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
            await showAlert(`File "${file.name}" exceeds 5MB limit.`);
            continue;
        }
        
        const totalSize = inlineAttachments.reduce((sum, att) => sum + att.size, 0);
        if (totalSize + file.size > MAX_TOTAL_SIZE) {
            await showAlert('Total attachment size would exceed 20MB limit.');
            break;
        }
        
        const base64 = await readFileAsBase64(file);
        inlineAttachments.push({
            name: file.name,
            type: file.type,
            size: file.size,
            data: base64
        });
    }
    
    renderInlineAttachments();
    e.target.value = '';
}

// Remove inline attachment
function removeInlineAttachment(index) {
    inlineAttachments.splice(index, 1);
    renderInlineAttachments();
}

// Update inline linked notes preview
function updateInlineLinkedNotesPreview() {
    const preview = document.getElementById('inlineLinkedNotesPreview');
    const linkedInput = document.getElementById('inlineLinked');
    if (!preview || !linkedInput) return;
    
    const linkedIds = linkedInput.value ? linkedInput.value.split(',').filter(id => id.trim()) : [];
    
    if (linkedIds.length === 0) {
        preview.innerHTML = 'No linked notes';
        return;
    }
    
    const linkedPreviews = linkedIds.map(id => {
        const linkedNote = notes.find(n => n.id === id);
        if (linkedNote) {
            return `<span class="linked-note-tag">${id}: ${linkedNote.title.substring(0, 20)}${linkedNote.title.length > 20 ? '...' : ''}</span>`;
        }
        return `<span class="linked-note-tag">${id}</span>`;
    }).join(' ');
    
    preview.innerHTML = linkedPreviews;
}

// Open link notes modal for inline edit
function openInlineLinkNotesModal() {
    const linkModal = document.getElementById('linkNotesModal');
    const linkedInput = document.getElementById('inlineLinked');
    const currentLinked = linkedInput.value ? linkedInput.value.split(',').filter(id => id.trim()) : [];
    
    // Store that we're in inline edit mode
    linkModal.dataset.inlineMode = 'true';
    
    // Populate the notes list
    const listContainer = document.getElementById('linkNotesList');
    const currentNoteId = inlineEditingId;
    
    const availableNotes = notes.filter(n => n.id !== currentNoteId);
    
    if (availableNotes.length === 0) {
        listContainer.innerHTML = '<div class="no-notes-message">No other notes available to link.</div>';
    } else {
        listContainer.innerHTML = availableNotes.map(note => `
            <div class="link-note-item">
                <label>
                    <input type="checkbox" value="${note.id}" ${currentLinked.includes(note.id) ? 'checked' : ''}>
                    <span class="link-note-id">${note.id}</span>
                    <span class="link-note-title">${note.title}</span>
                </label>
            </div>
        `).join('');
    }
    
    linkModal.classList.add('active');
    
    // Clear search
    const searchInput = document.getElementById('linkNotesSearch');
    if (searchInput) searchInput.value = '';
}

// Save inline edit
function saveInlineEdit() {
    if (!inlineEditingId) return;
    
    const note = notes.find(n => n.id === inlineEditingId);
    if (!note) return;
    
    const title = document.getElementById('inlineTitle').value.trim();
    const content = inlineQuillEditor.root.innerHTML;
    const isContentEmpty = !inlineQuillEditor.getText().trim();
    
    // Check if empty
    if (!title && isContentEmpty) {
        // Delete empty note
        notes = notes.filter(n => n.id !== inlineEditingId);
        saveToStorage();
        triggerAutosave();
        closeInlineEdit(true);
        return;
    }
    
    const category = document.getElementById('inlineCategory').value;
    const rating = parseInt(document.getElementById('inlineRating').value) || 3;
    const status = document.getElementById('inlineStatus').value;
    const dueDate = document.getElementById('inlineDueDate').value || null;
    const progress = parseInt(document.getElementById('inlineProgress').value) || 0;
    const additionalNotes = document.getElementById('inlineNotes').value.trim();
    const linkedNotesValue = document.getElementById('inlineLinked').value;
    const linkedNotes = linkedNotesValue ? linkedNotesValue.split(',').filter(id => id.trim()) : [];
    
    // Update note
    note.title = title;
    note.description = content;
    note.category = category;
    note.rating = rating;
    note.status = hasActionControls(category) ? status : null;
    note.dueDate = hasActionControls(category) ? dueDate : null;
    note.progress = hasActionControls(category) ? progress : null;
    note.notes = additionalNotes;
    note.attachments = inlineAttachments;
    note.linkedNotes = linkedNotes;
    note.updatedAt = new Date().toISOString();
    
    saveToStorage();
    triggerAutosave();
    closeInlineEdit(true);
}

// Close inline edit
function closeInlineEdit(shouldRerender = true) {
    if (!inlineEditingId) return;
    
    const card = document.querySelector(`.requirement-card[data-id="${inlineEditingId}"]`);
    const noteId = inlineEditingId;
    
    // Cleanup Quill
    if (inlineQuillEditor) {
        inlineQuillEditor = null;
    }
    
    inlineEditingId = null;
    inlineAttachments = [];
    
    if (shouldRerender) {
        renderNotes();
        updateStats();
        checkDueSoon();
    } else if (card) {
        // Restore original content
        const cardBody = card.querySelector('.card-body');
        if (card.dataset.originalBody) {
            cardBody.innerHTML = card.dataset.originalBody;
        }
        card.classList.remove('inline-editing');
        card.classList.remove('expanded'); // Also collapse the card
        
        // Restore the click handler for expand/collapse
        card.onclick = (e) => toggleNoteExpand(e, noteId);
    }
}

// Escape HTML for safe insertion
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== END INLINE EDIT MODE ==========

// Temporary storage for linked notes selection
let tempLinkedNotes = [];

// Populate Linked Notes Modal
function populateLinkedNotesModal(excludeId = null, currentLinked = []) {
    const listContainer = document.getElementById('linkNotesList');
    tempLinkedNotes = [...currentLinked];
    
    const availableNotes = notes.filter(n => n.id !== excludeId);
    
    if (availableNotes.length === 0) {
        listContainer.innerHTML = '<p class="no-notes-message">No other notes available to link.</p>';
        return;
    }
    
    listContainer.innerHTML = availableNotes.map(note => `
        <label class="link-note-item" data-id="${note.id}" data-title="${note.title.toLowerCase()}">
            <input type="checkbox" value="${note.id}" ${currentLinked.includes(note.id) ? 'checked' : ''}>
            <span class="link-note-id">${note.id}</span>
            <span class="link-note-title">${note.title.substring(0, 50)}${note.title.length > 50 ? '...' : ''}</span>
        </label>
    `).join('');
    
    // Add event listeners for checkboxes
    listContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const noteId = e.target.value;
            if (e.target.checked) {
                if (!tempLinkedNotes.includes(noteId)) {
                    tempLinkedNotes.push(noteId);
                }
            } else {
                tempLinkedNotes = tempLinkedNotes.filter(id => id !== noteId);
            }
        });
    });
}

// Open Link Notes Modal
function openLinkNotesModal() {
    const currentLinkedInput = document.getElementById('reqLinked');
    const currentLinked = currentLinkedInput.value ? currentLinkedInput.value.split(',').filter(Boolean) : [];
    
    populateLinkedNotesModal(currentEditId, currentLinked);
    document.getElementById('linkNotesSearch').value = '';
    document.getElementById('linkNotesModal').classList.add('active');
}

// Close Link Notes Modal
function closeLinkNotesModal() {
    document.getElementById('linkNotesModal').classList.remove('active');
}

// Confirm Link Notes Selection
function confirmLinkNotes() {
    const linkModal = document.getElementById('linkNotesModal');
    const isInlineMode = linkModal.dataset.inlineMode === 'true';
    
    // Get selected notes from checkboxes
    const checkboxes = document.querySelectorAll('#linkNotesList input[type="checkbox"]:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (isInlineMode) {
        // Inline edit mode
        const linkedInput = document.getElementById('inlineLinked');
        linkedInput.value = selectedIds.join(',');
        updateInlineLinkedNotesPreview();
        linkModal.dataset.inlineMode = '';
    } else {
        // Modal edit mode
        const linkedInput = document.getElementById('reqLinked');
        linkedInput.value = selectedIds.join(',');
        updateLinkedNotesPreview();
        autoSaveNote();
    }
    
    closeLinkNotesModal();
}

// Update the preview display of linked notes
function updateLinkedNotesPreview() {
    const linkedInput = document.getElementById('reqLinked');
    const preview = document.getElementById('linkedNotesPreview');
    const linkedIds = linkedInput.value ? linkedInput.value.split(',').filter(Boolean) : [];
    
    if (linkedIds.length === 0) {
        preview.innerHTML = 'No linked notes';
        preview.classList.remove('has-links');
    } else {
        const linkedTitles = linkedIds.map(id => {
            const note = notes.find(n => n.id === id);
            return note ? `<span class="linked-preview-tag">${id}</span>` : null;
        }).filter(Boolean).join(' ');
        preview.innerHTML = linkedTitles || 'No linked notes';
        preview.classList.add('has-links');
    }
}

// ========== ATTACHMENT FUNCTIONS ==========

// Get file icon based on file type
function getFileIcon(mimeType) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📽️';
    if (mimeType.includes('zip') || mimeType.includes('compressed')) return '🗜️';
    if (mimeType.includes('text')) return '📃';
    return '📎';
}

// Format file size for display
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Handle file selection for attachments
async function handleAttachmentSelect(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    // Calculate current total size
    const currentTotalSize = currentAttachments.reduce((sum, att) => sum + att.size, 0);
    
    for (const file of files) {
        // Check individual file size
        if (file.size > MAX_FILE_SIZE) {
            await showAlert(`File "${file.name}" exceeds the 5MB limit.`, '⚠️ File Too Large');
            continue;
        }
        
        // Check total size
        const newTotalSize = currentTotalSize + currentAttachments.reduce((sum, att) => sum + att.size, 0) + file.size;
        if (newTotalSize > MAX_TOTAL_SIZE) {
            await showAlert(`Adding "${file.name}" would exceed the 20MB total limit.`, '⚠️ Storage Limit');
            continue;
        }
        
        // Check for duplicate names
        if (currentAttachments.some(att => att.name === file.name)) {
            await showAlert(`File "${file.name}" is already attached.`, '⚠️ Duplicate File');
            continue;
        }
        
        // Read file as base64
        try {
            const base64 = await readFileAsBase64(file);
            currentAttachments.push({
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                data: base64
            });
        } catch (err) {
            console.error('Error reading file:', err);
            await showAlert(`Failed to read file "${file.name}".`, '❌ Error');
        }
    }
    
    // Clear input and refresh display
    e.target.value = '';
    renderAttachmentList();
    autoSaveNote();
}

// Read file as base64
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// Render attachment list in the form
function renderAttachmentList() {
    const container = document.getElementById('attachmentList');
    if (!container) return;
    
    if (currentAttachments.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = currentAttachments.map((att, index) => `
        <div class="attachment-item">
            <span class="attachment-icon">${getFileIcon(att.type)}</span>
            <span class="attachment-name" title="${att.name}">${att.name}</span>
            <span class="attachment-size">${formatFileSize(att.size)}</span>
            <button type="button" class="attachment-download" onclick="downloadAttachment(${index})" title="Download">⬇️</button>
            <button type="button" class="attachment-remove" onclick="removeAttachment(${index})" title="Remove">×</button>
        </div>
    `).join('');
}

// Remove an attachment
function removeAttachment(index) {
    currentAttachments.splice(index, 1);
    renderAttachmentList();
    autoSaveNote();
}

// Download an attachment
function downloadAttachment(index) {
    const att = currentAttachments[index];
    if (!att) return;
    
    const link = document.createElement('a');
    link.href = att.data;
    link.download = att.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Download attachment from a note (used in card view)
function downloadNoteAttachment(noteId, attachmentIndex) {
    event.stopPropagation(); // Prevent card expansion
    const note = notes.find(n => n.id === noteId);
    if (!note || !note.attachments || !note.attachments[attachmentIndex]) return;
    
    const att = note.attachments[attachmentIndex];
    const link = document.createElement('a');
    link.href = att.data;
    link.download = att.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Filter linked notes in modal
function filterLinkNotes(searchTerm) {
    const items = document.querySelectorAll('.link-note-item');
    const term = searchTerm.toLowerCase();
    
    items.forEach(item => {
        const id = item.dataset.id.toLowerCase();
        const title = item.dataset.title;
        const matches = id.includes(term) || title.includes(term);
        item.style.display = matches ? '' : 'none';
    });
}

// Handle Form Submit - just save final state and close
function handleFormSubmit(e) {
    e.preventDefault();
    
    // Validate Quill has content
    if (isQuillEmpty()) {
        showAlert('Please enter some content for your note.', '⚠️ Content Required');
        return;
    }
    
    // Do one final auto-save to ensure everything is captured
    autoSaveNote();
    
    // Clear filters after saving to ensure the note is visible
    clearFilters();
    
    // Close the modal (which will also clean up empty notes)
    noteModal.classList.remove('active');
    noteForm.reset();
    setQuillContent('');
    currentEditId = null;
}

// Delete Note
function deleteNote(id) {
    notes = notes.filter(n => n.id !== id);
    
    // Remove from linked notes
    notes.forEach(note => {
        if (note.linkedNotes) {
            note.linkedNotes = note.linkedNotes.filter(linkedId => linkedId !== id);
        }
    });
    
    saveToStorage();
    triggerAutosave();
    renderNotes();
    updateStats();
    checkDueSoon();
}

// Help Modal Functions
function openHelpModal() {
    document.getElementById('helpModal').classList.add('active');
}

function closeHelpModal() {
    document.getElementById('helpModal').classList.remove('active');
}

// Sidebar Toggle (Mobile)
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('active');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}

// New Notebook
async function startNewNotebook() {
    const confirmed = await showConfirm('Start a new stack?\n\nThis will remove all current notes and custom categories. Make sure to export your data first if you want to keep it.', '📓 New Stack');
    if (confirmed) {
        notes = [];
        notebookName = 'My Notebook';
        sessionEncryptionPassword = null; // Clear stored encryption password
        customCategories = []; // Clear custom categories
        autosaveEnabled = false; // Disable autosave for new notebook
        autosaveEncrypted = false;
        privateAccessGranted = false; // Reset private category access
        fileHandle = null;
        // Reset file info
        currentFileName = null;
        currentFilePath = null;
        lastModifiedDate = null;
        updateFileInfoDisplay();
        document.getElementById('projectName').value = notebookName;
        document.title = `${notebookName} - Stack`;
        populateCategoryDropdowns(); // Reset category dropdowns
        saveToStorage(); // Save to IndexedDB (clears session data)
        renderNotes();
        updateStats();
    }
}

// Toggle Note Card Expansion
function toggleNoteExpand(event, id) {
    // Don't toggle if clicking on buttons or links inside the card
    if (event.target.closest('.card-actions') || 
        event.target.closest('a') || 
        event.target.closest('.linked-tag')) {
        return;
    }
    
    const card = event.currentTarget;
    card.classList.toggle('expanded');
}

// View Note Details
function viewNote(id) {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    
    document.getElementById('viewModalTitle').textContent = note.title;
    
    const linkedNotesList = note.linkedNotes
        ?.map(linkedId => {
            const linked = notes.find(n => n.id === linkedId);
            return linked ? `<span class="linked-tag" onclick="viewNote('${linked.id}')">${linked.id}</span>` : null;
        })
        .filter(Boolean)
        .join('') || '<span class="text-muted">None</span>';
    
    const statusHtml = hasActionControls(note.category) && note.status 
        ? `<div class="detail-row">
            <div class="detail-label">Status</div>
            <div class="detail-badges">
                <span class="badge badge-status badge-status-${note.status}">${formatStatus(note.status)}</span>
            </div>
           </div>`
        : '';
    
    const actionDetailsHtml = hasActionControls(note.category)
        ? `${(note.progress || 0) > 0 ? `<div class="detail-row">
            <div class="detail-label">Progress</div>
            <div class="detail-value">
                <div class="progress-container view-modal-progress">
                    <div class="progress-bar">
                        <div class="progress-fill ${getProgressClass(note.progress || 0)}" style="width: ${note.progress || 0}%"></div>
                    </div>
                    <span class="progress-percentage">${note.progress || 0}%</span>
                </div>
            </div>
           </div>` : ''}
           ${note.dueDate ? `
           <div class="detail-row">
               <div class="detail-label">Due Date</div>
               <div class="detail-value ${isDueDateOverdue(note.dueDate, note.status, note.progress) ? 'overdue-text' : isDueDateSoon(note.dueDate, note.status, note.progress) ? 'due-soon-text' : ''}">
                   📆 ${formatDueDate(note.dueDate)} ${isDueDateOverdue(note.dueDate, note.status, note.progress) ? '<span class="overdue-badge">⚠️ Overdue</span>' : ''}${isDueDateSoon(note.dueDate, note.status, note.progress) && !isDueDateOverdue(note.dueDate, note.status, note.progress) ? '<span class="due-soon-badge">⏰ Due Soon</span>' : ''}
               </div>
           </div>` : ''}`
        : '';
    
    document.getElementById('viewModalContent').innerHTML = `
        <div class="detail-row">
            <div class="detail-label">ID</div>
            <div class="detail-value">${note.id}</div>
        </div>
        <div class="detail-row">
            <div class="detail-label">Title</div>
            <div class="detail-value">${linkifyText(note.title)}</div>
        </div>
        <div class="detail-row">
            <div class="detail-label">Content</div>
            <div class="detail-value rich-text-content">${renderRichText(note.description)}</div>
        </div>
        <div class="detail-row">
            <div class="detail-label">Category & Rating</div>
            <div class="detail-badges">
                <span class="badge badge-category badge-category-${note.category}">${formatCategory(note.category)}</span>
                <span class="badge badge-rating">${getStarDisplay(note.rating)}</span>
            </div>
        </div>
        ${statusHtml}
        ${actionDetailsHtml}
        <div class="detail-row">
            <div class="detail-label">Linked Notes</div>
            <div class="linked-tags">${linkedNotesList}</div>
        </div>
        ${note.attachments?.length > 0 ? `
        <div class="detail-row">
            <div class="detail-label">Attachments</div>
            <div class="detail-value">
                <div class="view-attachments-list">
                    ${note.attachments.map((att, idx) => `
                        <div class="view-attachment-item" onclick="downloadNoteAttachment('${note.id}', ${idx})">
                            <span class="view-att-name">${att.name}</span>
                            <span class="view-att-size">${formatFileSize(att.size)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
        ` : ''}
        ${note.notes ? `
        <div class="detail-row">
            <div class="detail-label">Additional Notes</div>
            <div class="detail-value">${linkifyText(note.notes)}</div>
        </div>
        ` : ''}
        <div class="detail-row">
            <div class="detail-label">Created</div>
            <div class="detail-value">${formatDate(note.createdAt)}</div>
        </div>
        <div class="detail-row">
            <div class="detail-label">Last Updated</div>
            <div class="detail-value">${formatDate(note.updatedAt)}</div>
        </div>
    `;
    
    viewModal.dataset.currentId = id;
    viewModal.classList.add('active');
}

// Close View Modal
function closeViewModal() {
    viewModal.classList.remove('active');
}

// Print from View Modal
function printFromView() {
    const id = viewModal.dataset.currentId;
    const note = notes.find(n => n.id === id);
    if (!note) return;
    
    const printContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${note.title} - ${projectName}</title>
            <style>
                body {
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    padding: 2rem;
                    max-width: 800px;
                    margin: 0 auto;
                    color: #1e293b;
                    line-height: 1.6;
                }
                h1 {
                    font-size: 1.5rem;
                    margin-bottom: 0.5rem;
                    border-bottom: 2px solid #6366f1;
                    padding-bottom: 0.5rem;
                }
                .note-meta {
                    color: #64748b;
                    font-size: 0.875rem;
                    margin-bottom: 1.5rem;
                }
                .note-meta span {
                    margin-right: 1rem;
                }
                .section {
                    margin-bottom: 1.5rem;
                }
                .section-label {
                    font-weight: 600;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    color: #64748b;
                    margin-bottom: 0.25rem;
                }
                .section-content {
                    color: #1e293b;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    margin: 0.5em 0;
                }
                td, th {
                    border: 1px solid #e2e8f0;
                    padding: 0.5em 0.75em;
                    text-align: left;
                }
                th {
                    background: #f1f5f9;
                    font-weight: 600;
                }
                blockquote {
                    border-left: 3px solid #6366f1;
                    padding-left: 1em;
                    margin: 0.5em 0;
                    color: #64748b;
                }
                pre, code {
                    background: #f1f5f9;
                    padding: 0.25em 0.5em;
                    border-radius: 4px;
                    font-family: monospace;
                }
                .badge {
                    display: inline-block;
                    padding: 0.25rem 0.5rem;
                    border: 1px solid #64748b;
                    border-radius: 4px;
                    font-size: 0.75rem;
                    margin-right: 0.5rem;
                }
                @media print {
                    body { padding: 0; }
                }
            </style>
        </head>
        <body>
            <h1>${escapeHtml(note.title)}</h1>
            <div class="note-meta">
                <span><strong>ID:</strong> ${note.id}</span>
                <span><strong>Category:</strong> ${formatCategory(note.category)}</span>
                <span><strong>Rating:</strong> ${getStarDisplay(note.rating)}</span>
                ${hasActionControls(note.category) && note.status ? `<span><strong>Status:</strong> ${formatStatus(note.status)}</span>` : ''}
            </div>
            <div class="section">
                <div class="section-label">Content</div>
                <div class="section-content">${note.description || ''}</div>
            </div>
            ${hasActionControls(note.category) && note.progress ? `
            <div class="section">
                <div class="section-label">Progress</div>
                <div class="section-content">${note.progress}%</div>
            </div>
            ` : ''}
            ${hasActionControls(note.category) && note.dueDate ? `
            <div class="section">
                <div class="section-label">Due Date</div>
                <div class="section-content">${formatDueDate(note.dueDate)}</div>
            </div>
            ` : ''}
            ${note.notes ? `
            <div class="section">
                <div class="section-label">Additional Notes</div>
                <div class="section-content">${escapeHtml(note.notes)}</div>
            </div>
            ` : ''}
            <div class="section">
                <div class="section-label">Created</div>
                <div class="section-content">${formatDate(note.createdAt)}</div>
            </div>
            <div class="section">
                <div class="section-label">Last Updated</div>
                <div class="section-content">${formatDate(note.updatedAt)}</div>
            </div>
        </body>
        </html>
    `;
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
        printWindow.print();
    }, 250);
}

// Edit from View Modal
function editFromView() {
    const id = viewModal.dataset.currentId;
    closeViewModal();
    openInlineEdit(id); // Changed from openModal to use inline editing
}

// Get Star Display
function getStarDisplay(rating) {
    const filled = '★'.repeat(rating);
    const empty = '☆'.repeat(5 - rating);
    return filled + empty;
}

// Render Notes
function renderNotes() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const filterCategory = document.getElementById('filterCategory').value;
    const filterRating = document.getElementById('filterPriority').value;
    const filterStatus = document.getElementById('filterStatus').value;
    const sortBy = document.getElementById('sortBy').value;
    
    // For due-soon filter, calculate the threshold date (48 hours from now)
    const today = getStartOfToday();
    const dueSoonThreshold = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
    
    let filtered = notes.filter(note => {
        const matchesSearch = !searchTerm || 
            note.title.toLowerCase().includes(searchTerm) ||
            note.description.toLowerCase().includes(searchTerm) ||
            note.id.toLowerCase().includes(searchTerm);
        const matchesCategory = !filterCategory || note.category === filterCategory;
        const matchesRating = !filterRating || note.rating === parseInt(filterRating);
        const matchesStatus = !filterStatus || (hasActionControls(note.category) && note.status === filterStatus);
        
        // Hide archived notes unless archive filter is specifically selected
        const isArchived = note.category === 'archive';
        const showArchived = filterCategory === 'archive';
        if (isArchived && !showArchived) return false;
        
        // Hide private notes unless private category is specifically selected AND access is granted
        // Private notes behave like archived notes - hidden from main view
        const isPrivate = note.category === 'private';
        const showPrivate = filterCategory === 'private' && privateAccessGranted;
        if (isPrivate && !showPrivate) return false;
        
        // Also hide private notes from search results unless viewing private category
        if (isPrivate && filterCategory !== 'private') return false;
        
        // Due Soon filter: only show items that are due soon or overdue
        if (sortBy === 'due-soon') {
            // Must have action controls and a due date
            if (!hasActionControls(note.category) || !note.dueDate) return false;
            // Exclude completed and cancelled items
            if (note.status === 'completed' || note.status === 'cancelled') return false;
            // Exclude items at 100% progress
            if ((note.progress || 0) >= 100) return false;
            // Must be due soon (within threshold) or overdue
            const dueDate = parseLocalDate(note.dueDate);
            if (dueDate >= dueSoonThreshold) return false; // Not due soon enough
        }
        
        // Overdue filter: only show items that are past their due date
        if (sortBy === 'overdue') {
            // Must have action controls and a due date
            if (!hasActionControls(note.category) || !note.dueDate) return false;
            // Exclude completed and cancelled items
            if (note.status === 'completed' || note.status === 'cancelled') return false;
            // Exclude items at 100% progress
            if ((note.progress || 0) >= 100) return false;
            // Must be overdue (past due date)
            const dueDate = parseLocalDate(note.dueDate);
            const endOfToday = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1);
            if (dueDate >= endOfToday) return false; // Not overdue yet
        }
        
        return matchesSearch && matchesCategory && matchesRating && matchesStatus;
    });
    
    // Sort
    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'rating':
                return b.rating - a.rating;
            case 'category':
                return a.category.localeCompare(b.category);
            case 'date':
                return new Date(b.updatedAt) - new Date(a.updatedAt);
            case 'status':
                const statusA = a.status ? statusOrder[a.status] : 99;
                const statusB = b.status ? statusOrder[b.status] : 99;
                return statusA - statusB;
            case 'due':
                // Sort by due date (items with due dates first, then by date ascending)
                const dueDateA = a.dueDate ? parseLocalDate(a.dueDate) : null;
                const dueDateB = b.dueDate ? parseLocalDate(b.dueDate) : null;
                if (dueDateA && dueDateB) return dueDateA - dueDateB;
                if (dueDateA) return -1;
                if (dueDateB) return 1;
                return 0;
            case 'due-soon':
                // Sort by due date ascending (soonest first)
                const dueSoonA = a.dueDate ? parseLocalDate(a.dueDate) : null;
                const dueSoonB = b.dueDate ? parseLocalDate(b.dueDate) : null;
                if (dueSoonA && dueSoonB) return dueSoonA - dueSoonB;
                return 0;
            case 'overdue':
                // Sort by due date ascending (most overdue first)
                const overdueA = a.dueDate ? parseLocalDate(a.dueDate) : null;
                const overdueB = b.dueDate ? parseLocalDate(b.dueDate) : null;
                if (overdueA && overdueB) return overdueA - overdueB;
                return 0;
            default:
                return a.id.localeCompare(b.id);
        }
    });
    
    if (filtered.length === 0) {
        const isNewSession = notes.length === 0;
        
        if (isNewSession) {
            notesContainer.innerHTML = `
                <div class="empty-state hero-state">
                    <div class="hero-content">
                        <div class="hero-badge">Welcome to Scribe Stack</div>
                        <h1 class="hero-title">Your Ideas,<br><span class="gradient-text">Organized Beautifully</span></h1>
                        <p class="hero-subtitle" style="margin-bottom: 1.5rem;">A powerful yet simple note-taking app to capture thoughts, track tasks, and keep everything in one place.</p>
                        <button class="hero-cta" onclick="document.getElementById('addRequirementBtn').click()">
                            <span class="cta-icon">✨</span> Create Your First Note
                        </button>
                    </div>
                    <div class="hero-features">
                        <div class="feature-card">
                            <div class="feature-icon">📝</div>
                            <h4>Rich Text Notes</h4>
                            <p>Format with bold, lists, code blocks & more</p>
                        </div>
                        <div class="feature-card">
                            <div class="feature-icon">📁</div>
                            <h4>Smart Categories</h4>
                            <p>Organize by work, personal, ideas & custom tags</p>
                        </div>
                        <div class="feature-card">
                            <div class="feature-icon">🔒</div>
                            <h4>Encrypted Saves</h4>
                            <p>Password-protect your sensitive notes</p>
                        </div>
                        <div class="feature-card">
                            <div class="feature-icon">📎</div>
                            <h4>File Attachments</h4>
                            <p>Attach images, docs & files up to 25MB</p>
                        </div>
                    </div>
                    <div class="hero-footer">
                        <span>📤 Open an existing file</span>
                        <span class="divider">•</span>
                        <span>🌙 Dark mode included</span>
                        <span class="divider">•</span>
                        <span>🖨️ Print-ready exports</span>
                    </div>
                </div>
            `;
        } else {
            notesContainer.innerHTML = `
                <div class="empty-state">
                    <div class="icon">🔍</div>
                    <h3>No Notes Found</h3>
                    <p>Try adjusting your filters or search term.</p>
                    <button class="btn btn-secondary" onclick="document.getElementById('clearFilters').click()" style="margin-top: 1rem;">Clear Filters</button>
                </div>
            `;
        }
        return;
    }
    
    notesContainer.innerHTML = filtered.map(note => createNoteCard(note)).join('');
}

// Create Note Card HTML
function createNoteCard(note) {
    const linkedNotesList = note.linkedNotes?.length > 0
        ? `<div class="linked-requirements">
            <h4>🔗 Linked Notes</h4>
            <div class="linked-tags">
                ${note.linkedNotes.map(linkedId => {
                    const linked = notes.find(n => n.id === linkedId);
                    return linked 
                        ? `<span class="linked-tag" onclick="viewNote('${linked.id}')">${linked.id}</span>`
                        : '';
                }).join('')}
            </div>
           </div>`
        : '';
    
    const statusBadge = hasActionControls(note.category) && note.status
        ? `<span class="badge badge-status badge-status-${note.status}">${formatStatus(note.status)}</span>`
        : '';
    
    const progressBar = hasActionControls(note.category) && (note.progress || 0) > 0
        ? `<div class="progress-container">
            <div class="progress-bar">
                <div class="progress-fill ${getProgressClass(note.progress || 0)}" style="width: ${note.progress || 0}%"></div>
            </div>
            <span class="progress-percentage">${note.progress || 0}%</span>
           </div>`
        : '';
    
    const dueDateDisplay = hasActionControls(note.category) && note.dueDate
        ? `<div class="due-date-display ${isDueDateOverdue(note.dueDate, note.status, note.progress) ? 'overdue' : isDueDateSoon(note.dueDate, note.status, note.progress) ? 'due-soon' : ''}">
            <span class="icon">📆</span>
            <span>Due: ${formatDueDate(note.dueDate)}</span>
            ${isDueDateOverdue(note.dueDate, note.status, note.progress) ? '<span class="overdue-badge">⚠️ Overdue</span>' : ''}
            ${isDueDateSoon(note.dueDate, note.status, note.progress) && !isDueDateOverdue(note.dueDate, note.status, note.progress) ? '<span class="due-soon-badge">⏰ Due Soon</span>' : ''}
           </div>`
        : '';
    
    // Attachments display in card summary
    const attachmentsDisplay = note.attachments?.length > 0
        ? `<div class="card-attachments">
            ${note.attachments.map((att, idx) => 
                `<span class="card-attachment-tag" onclick="downloadNoteAttachment('${note.id}', ${idx})" title="Click to download (${formatFileSize(att.size)})">
                    ${att.name}
                </span>`
            ).join('')}
           </div>`
        : '';
    
    // Private note indicator
    const isPrivateNote = note.category === 'private';
    const privateIndicator = isPrivateNote ? '<span class="private-indicator" title="Private Note">🔐</span>' : '';
    const privateCardClass = isPrivateNote ? ' private-note' : '';
    
    return `
        <div class="requirement-card${privateCardClass}" data-id="${note.id}" onclick="toggleNoteExpand(event, '${note.id}')">
            <div class="card-header">
                <div class="card-header-left">
                    ${privateIndicator}
                    <h3 class="card-title">${linkifyText(note.title)}</h3>
                </div>
                <div class="card-header-right">
                    <div class="card-badges">
                        <span class="badge badge-category badge-category-${note.category}">${formatCategory(note.category)}</span>
                        <span class="badge badge-rating">${getStarDisplay(note.rating)}</span>
                        ${statusBadge}
                    </div>
                </div>
            </div>
            <div class="card-summary">
                <div class="meta-item">
                    <span>${formatDate(note.updatedAt)}</span>
                </div>
                ${attachmentsDisplay}
            </div>
            <div class="card-body">
                <div class="card-description rich-text-content">${renderRichText(note.description)}</div>
                ${progressBar}
                ${dueDateDisplay}
                ${linkedNotesList}
                <div class="card-footer">
                    <div class="meta-item">
                        <span>${formatDate(note.updatedAt)}</span>
                    </div>
                    <div class="card-actions">
                        <button class="btn btn-sm btn-secondary" onclick="viewNote('${note.id}')">View</button>
                        <button class="btn btn-sm btn-primary" onclick="openInlineEdit('${note.id}')">Edit</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteNote('${note.id}')">Delete</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Update Statistics
function updateStats() {
    const setTextIfExists = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    
    setTextIfExists('totalCount', notes.length);
    
    // Count notes with action controls (action category + custom categories)
    const actionNotes = notes.filter(n => hasActionControls(n.category));
    setTextIfExists('totalActions', actionNotes.length);
    
    const avgRating = notes.length > 0 
        ? (notes.reduce((sum, n) => sum + n.rating, 0) / notes.length).toFixed(1)
        : 0;
    setTextIfExists('avgRating', `${avgRating} ★`);
    
    // Status counts (for notes with action controls)
    setTextIfExists('statusNotStarted', actionNotes.filter(n => n.status === 'not-started').length);
    setTextIfExists('statusInProgress', actionNotes.filter(n => n.status === 'in-progress').length);
    setTextIfExists('statusCompleted', actionNotes.filter(n => n.status === 'completed').length);
    setTextIfExists('statusDeferred', actionNotes.filter(n => n.status === 'deferred').length);
    setTextIfExists('statusCancelled', actionNotes.filter(n => n.status === 'cancelled').length);
    
    // Rating counts
    setTextIfExists('rating5', notes.filter(n => n.rating === 5).length);
    setTextIfExists('rating4', notes.filter(n => n.rating === 4).length);
    setTextIfExists('rating3', notes.filter(n => n.rating === 3).length);
    setTextIfExists('rating2', notes.filter(n => n.rating === 2).length);
    setTextIfExists('rating1', notes.filter(n => n.rating === 1).length);
    
    // Category counts - dynamically generated
    const categoryCounts = {};
    notes.forEach(note => {
        const cat = note.category || 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    
    const categoryStatsContainer = document.getElementById('categoryStats');
    if (categoryStatsContainer) {
        categoryStatsContainer.innerHTML = Object.entries(categoryCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([category, count]) => `
                <div class="stat-item">
                    <span class="stat-label">${formatCategory(category)}</span>
                    <span class="stat-value">${count}</span>
                </div>
            `).join('') || '<div class="stat-item"><span class="stat-label">No notes</span></div>';
    }
    
    // Update filter dropdowns with counts
    populateCategoryDropdowns();
    populateStatusFilter();
}

// Handle category filter change - special handling for Private category
async function handleCategoryFilterChange(e) {
    const selectedCategory = e.target.value;
    
    // If Private category is selected, prompt for password
    if (selectedCategory === 'private') {
        // Reset access state
        privateAccessGranted = false;
        
        // Check if file is encrypted
        if (!autosaveEncrypted || !sessionEncryptionPassword) {
            await showAlert('Private notes are only available for encrypted files. Please save your file with encryption first.', '🔒 Encryption Required');
            e.target.value = ''; // Reset to "All Categories"
            renderNotes();
            return;
        }
        
        // Prompt for password
        const password = await showPrompt(
            'Enter your encryption password to view private notes:',
            '🔐 Private Notes Access',
            { inputType: 'password', placeholder: 'Enter encryption password' }
        );
        
        if (!password) {
            // User cancelled
            e.target.value = ''; // Reset to "All Categories"
            renderNotes();
            return;
        }
        
        // Verify password matches the session encryption password
        if (password !== sessionEncryptionPassword) {
            await showAlert('Incorrect password. Access denied.', '❌ Access Denied');
            e.target.value = ''; // Reset to "All Categories"
            privateAccessGranted = false;
            renderNotes();
            return;
        }
        
        // Password correct - grant access
        privateAccessGranted = true;
        await showAlert('Access granted. Private notes are now visible.\n\nYou can recategorize notes while viewing this category.', '✅ Access Granted');
    } else {
        // Any other category selected - revoke private access
        privateAccessGranted = false;
    }
    
    renderNotes();
}

// Clear Filters
function clearFilters() {
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterPriority').value = '';
    document.getElementById('filterStatus').value = '';
    document.getElementById('searchInput').value = '';
    privateAccessGranted = false; // Reset private access when clearing filters
    renderNotes();
}

// ========== DUE SOON NOTIFICATIONS ==========

let dueSoonDismissed = false;

// Parse date string as local date (not UTC)
function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    return new Date(parts[0], parts[1] - 1, parts[2]); // year, month (0-indexed), day
}

// Get start of today (midnight local time)
function getStartOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Get start of tomorrow (midnight local time)
function getStartOfTomorrow() {
    const today = getStartOfToday();
    return new Date(today.getTime() + 24 * 60 * 60 * 1000);
}

// Check for action items due within 24 hours
function checkDueSoon() {
    const today = getStartOfToday();
    const dayAfterTomorrow = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
    
    // Find notes with action controls that have due dates (overdue or due soon)
    const overdue = [];
    const dueSoon = [];
    
    notes.forEach(note => {
        if (!hasActionControls(note.category) || !note.dueDate) return;
        if (note.status === 'completed' || note.status === 'cancelled') return;
        if ((note.progress || 0) >= 100) return; // 100% complete is not due soon
        
        const dueDate = parseLocalDate(note.dueDate);
        if (dueDate < today) {
            overdue.push(note);
        } else if (dueDate < dayAfterTomorrow) {
            dueSoon.push(note);
        }
    });
    
    const banner = document.getElementById('dueSoonBanner');
    const message = document.getElementById('dueSoonMessage');
    
    const hasItems = overdue.length > 0 || dueSoon.length > 0;
    
    if (hasItems && !dueSoonDismissed) {
        let messageText = '';
        if (overdue.length > 0) {
            messageText += `${overdue.length} overdue! `;
        }
        if (dueSoon.length > 0) {
            messageText += `${dueSoon.length} due in 24 hours.`;
        }
        
        message.textContent = messageText.trim();
        banner.style.display = 'flex';
        banner.classList.toggle('has-overdue', overdue.length > 0);
    } else {
        banner.style.display = 'none';
    }
}

// Show due soon items (filter and sort by due date)
function showDueSoonItems() {
    // Clear filters and select due-soon filter
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterPriority').value = '';
    document.getElementById('filterStatus').value = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('sortBy').value = 'due-soon';
    renderNotes();
}

// Dismiss due soon banner for this session
function dismissDueSoon() {
    dueSoonDismissed = true;
    document.getElementById('dueSoonBanner').style.display = 'none';
}

// ========== ENCRYPTION UTILITIES ==========

// Derive encryption key from password using PBKDF2
async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Encrypt data with password
async function encryptData(data, password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoder.encode(data)
    );
    
    // Combine salt + iv + encrypted data
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    
    // Convert to base64 (chunked for large data)
    return arrayBufferToBase64(combined);
}

// Convert ArrayBuffer to base64 (handles large data)
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

// Decrypt data with password
async function decryptData(encryptedBase64, password) {
    const decoder = new TextDecoder();
    
    // Decode base64
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    
    // Extract salt, iv, and encrypted data
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encrypted = combined.slice(28);
    
    const key = await deriveKey(password, salt);
    
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encrypted
    );
    
    return decoder.decode(decrypted);
}

// ========== SAVE/IMPORT ==========

// Show saving indicator - flash green on save button
function showSavingIndicator() {
    const exportBtn = document.getElementById('exportBtn');
    const exportBtnMobile = document.getElementById('exportBtnMobile');
    if (exportBtn) exportBtn.classList.add('saving-flash');
    if (exportBtnMobile) exportBtnMobile.classList.add('saving-flash');
}

// Hide saving indicator
function hideSavingIndicator() {
    const exportBtn = document.getElementById('exportBtn');
    const exportBtnMobile = document.getElementById('exportBtnMobile');
    // Remove class after animation completes
    setTimeout(() => {
        if (exportBtn) exportBtn.classList.remove('saving-flash');
        if (exportBtnMobile) exportBtnMobile.classList.remove('saving-flash');
    }, 600);
}

// Update file info display
function updateFileInfoDisplay() {
    const fileInfoDisplay = document.getElementById('fileInfoDisplay');
    const fileInfoName = document.getElementById('fileInfoName');
    const fileInfoPath = document.getElementById('fileInfoPath');
    const fileInfoModified = document.getElementById('fileInfoModified');
    const fileInfoEncryption = document.getElementById('fileInfoEncryption');
    
    if (!fileInfoDisplay || !fileInfoName || !fileInfoPath || !fileInfoModified) return;
    
    if (currentFileName) {
        fileInfoDisplay.classList.remove('no-file');
        fileInfoName.textContent = currentFileName;
        fileInfoPath.textContent = currentFilePath || '';
        
        if (lastModifiedDate) {
            const date = new Date(lastModifiedDate);
            const formattedDate = date.toLocaleDateString(undefined, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
            const formattedTime = date.toLocaleTimeString(undefined, { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            fileInfoModified.textContent = `Modified: ${formattedDate} at ${formattedTime}`;
        } else {
            fileInfoModified.textContent = '';
        }
        
        // Update encryption status
        if (fileInfoEncryption) {
            if (autosaveEncrypted) {
                fileInfoEncryption.textContent = '🔒 Encrypted';
                fileInfoEncryption.className = 'file-info-encryption encrypted';
            } else {
                fileInfoEncryption.textContent = '🔓 Not Encrypted';
                fileInfoEncryption.className = 'file-info-encryption not-encrypted';
            }
        }
    } else {
        fileInfoDisplay.classList.add('no-file');
        fileInfoName.textContent = 'No file opened';
        fileInfoPath.textContent = '';
        fileInfoModified.textContent = '';
        if (fileInfoEncryption) {
            fileInfoEncryption.textContent = '';
            fileInfoEncryption.className = 'file-info-encryption';
        }
    }
}

// ========== FILE CONFLICT DETECTION ==========

// Store the last known modification time from disk (in milliseconds)
let lastKnownDiskModified = null;

// Check if the file on disk has been modified externally
async function checkFileConflict() {
    if (!fileHandle) return { hasConflict: false };
    
    try {
        const file = await fileHandle.getFile();
        const diskModified = file.lastModified;
        
        // If we don't have a baseline, set it now
        if (lastKnownDiskModified === null) {
            lastKnownDiskModified = diskModified;
            return { hasConflict: false };
        }
        
        // Check if file on disk is newer than our last known state
        if (diskModified > lastKnownDiskModified) {
            return { 
                hasConflict: true, 
                diskModified: new Date(diskModified),
                ourModified: new Date(lastKnownDiskModified)
            };
        }
        
        return { hasConflict: false };
    } catch (err) {
        console.log('Could not check file conflict:', err);
        // File might have been deleted or handle invalidated
        return { hasConflict: false, error: err };
    }
}

// Handle file conflict - returns action: 'overwrite', 'reload', 'saveas', 'cancel'
async function handleFileConflict(conflictInfo) {
    const diskTime = conflictInfo.diskModified.toLocaleString();
    const ourTime = conflictInfo.ourModified.toLocaleString();
    
    const message = `The file has been modified externally!\n\n` +
        `File on disk: ${diskTime}\n` +
        `Your last save: ${ourTime}\n\n` +
        `What would you like to do?`;
    
    // Show conflict resolution dialog
    const choice = await showConflictDialog(message);
    return choice;
}

// Custom conflict resolution dialog
async function showConflictDialog(message) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.id = 'conflictModal';
        modal.innerHTML = `
            <div class="modal-content modal-sm">
                <div class="modal-header">
                    <h2>⚠️ File Conflict Detected</h2>
                </div>
                <div class="view-content">
                    <p style="white-space: pre-line; margin-bottom: 1.5rem;">${message}</p>
                    <div class="conflict-options">
                        <button class="btn btn-danger btn-full" data-action="overwrite" style="margin-bottom: 0.5rem;">
                            Overwrite File (Use My Version)
                        </button>
                        <button class="btn btn-secondary btn-full" data-action="reload" style="margin-bottom: 0.5rem;">
                            Reload File (Discard My Changes)
                        </button>
                        <button class="btn btn-primary btn-full" data-action="saveas" style="margin-bottom: 0.5rem;">
                            Save As New File
                        </button>
                        <button class="btn btn-text btn-full" data-action="cancel">
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        modal.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                modal.remove();
                resolve(action);
            });
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
                resolve('cancel');
            }
        });
    });
}

// Update the last known disk modified time after successful save
function updateLastKnownDiskModified() {
    lastKnownDiskModified = Date.now();
}

// Reset conflict tracking when opening a new file
async function initializeConflictTracking(handle) {
    if (handle) {
        try {
            const file = await handle.getFile();
            lastKnownDiskModified = file.lastModified;
        } catch (err) {
            lastKnownDiskModified = Date.now();
        }
    } else {
        lastKnownDiskModified = null;
    }
}

// Reload the file from disk (discard local changes)
async function reloadFileFromDisk() {
    if (!fileHandle) {
        await showAlert('No file handle available to reload from.', '⚠️ Error');
        return;
    }
    
    try {
        const file = await fileHandle.getFile();
        const content = await file.text();
        
        // Process the file content (reuse the import logic)
        await processImportedFile(content, file.name, file.lastModified, fileHandle);
        
        // Initialize conflict tracking with the reloaded file
        await initializeConflictTracking(fileHandle);
        
        await showAlert('File reloaded from disk successfully.', '✅ Reloaded');
    } catch (err) {
        console.error('Failed to reload file from disk:', err);
        await showAlert('Failed to reload file from disk. The file may have been moved or deleted.', '❌ Error');
    }
}

// ========== END FILE CONFLICT DETECTION ==========

// Trigger autosave (debounced)
function triggerAutosave() {
    if (!autosaveEnabled) return;
    
    // Debounce: wait 2 seconds after last change before saving
    if (autosaveTimeout) clearTimeout(autosaveTimeout);
    autosaveTimeout = setTimeout(async () => {
        await performAutosave();
    }, 2000);
}

// Perform the actual autosave
async function performAutosave() {
    if (!autosaveEnabled) return;
    
    // Validate encryption state before saving
    const stateValid = await validateFileState();
    if (!stateValid) {
        console.log('Autosave skipped - encryption state validation failed');
        return;
    }
    
    // Check for file conflicts before autosaving
    if (fileHandle) {
        const conflict = await checkFileConflict();
        if (conflict.hasConflict) {
            const action = await handleFileConflict(conflict);
            
            switch (action) {
                case 'overwrite':
                    // Continue with save
                    break;
                case 'reload':
                    // Reload the file from disk
                    await reloadFileFromDisk();
                    return;
                case 'saveas':
                    // Clear file handle to force "Save As" dialog
                    fileHandle = null;
                    lastKnownDiskModified = null;
                    await saveToFile();
                    return;
                case 'cancel':
                default:
                    console.log('Autosave cancelled due to file conflict');
                    return;
            }
        }
    }
    
    showSavingIndicator();
    
    try {
        const exportData = {
            notebookName: notebookName,
            exportedAt: new Date().toISOString(),
            customCategories: customCategories,
            notes: notes
        };
        const dataStr = JSON.stringify(exportData, null, 2);
        
        let finalData;
        
        if (autosaveEncrypted && sessionEncryptionPassword) {
            const encryptedContent = await encryptData(dataStr, sessionEncryptionPassword);
            finalData = JSON.stringify({
                encrypted: true,
                version: 1,
                data: encryptedContent
            });
        } else {
            finalData = dataStr;
        }
        
        const blob = new Blob([finalData], { type: 'application/json' });
        
        // Try to save to the same file handle if we have one
        if (fileHandle) {
            try {
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                // Update last modified date on successful autosave
                lastModifiedDate = new Date().toISOString();
                updateLastKnownDiskModified(); // Update conflict tracking
                updateFileInfoDisplay();
                // Persist encryption state after successful save
                persistEncryptionState();
            } catch (err) {
                console.log('Could not save to file handle:', err);
                // File handle may have been invalidated, clear it
                fileHandle = null;
                lastKnownDiskModified = null;
            }
        }
        // If no file handle, data is still in IndexedDB, user can manually save
    } catch (error) {
        console.error('Autosave error:', error);
    } finally {
        setTimeout(hideSavingIndicator, 500);
    }
}

// Save to JSON (manual save)
async function saveToFile() {
    // Validate encryption state before saving
    if (autosaveEnabled) {
        const stateValid = await validateFileState();
        if (!stateValid) {
            return; // User cancelled
        }
    }
    
    // Check for file conflicts before saving
    if (fileHandle) {
        const conflict = await checkFileConflict();
        if (conflict.hasConflict) {
            const action = await handleFileConflict(conflict);
            
            switch (action) {
                case 'overwrite':
                    // Continue with save
                    break;
                case 'reload':
                    // Reload the file from disk
                    await reloadFileFromDisk();
                    return;
                case 'saveas':
                    // Clear file handle to force "Save As" dialog
                    fileHandle = null;
                    lastKnownDiskModified = null;
                    // Continue with save - will prompt for new location
                    break;
                case 'cancel':
                default:
                    return;
            }
        }
    }
    
    // Show the green flash indicator
    showSavingIndicator();
    
    const exportData = {
        notebookName: notebookName,
        exportedAt: new Date().toISOString(),
        customCategories: customCategories,
        notes: notes
    };
    const dataStr = JSON.stringify(exportData, null, 2);
    
    let finalData, fileName;
    const safeName = notebookName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const dateStr = new Date().toISOString().split('T')[0];
    
    // If autosave is already enabled, use existing encryption setting
    if (autosaveEnabled) {
        if (autosaveEncrypted && sessionEncryptionPassword) {
            try {
                const encryptedContent = await encryptData(dataStr, sessionEncryptionPassword);
                finalData = JSON.stringify({
                    encrypted: true,
                    version: 1,
                    data: encryptedContent
                });
                fileName = `${safeName}-notes-${dateStr}.encrypted.json`;
            } catch (error) {
                console.error('Encryption error:', error);
                await showAlert('Encryption failed. Saving as plain JSON instead.', '⚠️ Warning');
                finalData = dataStr;
                fileName = `${safeName}-notes-${dateStr}.json`;
            }
        } else {
            finalData = dataStr;
            fileName = `${safeName}-notes-${dateStr}.json`;
        }
    } else {
        // First save - ask user about encryption
        const encrypt = await showConfirm('Do you want to password-protect your saves?\n\nYes = Encrypt with password\nNo = Save as plain JSON\n\nThis setting will be used for autosave.', '🔐 Save Options');
        
        if (encrypt) {
            const password = await showPrompt('Enter a password for encryption:', '🔑 Set Password', { 
                inputType: 'password', 
                placeholder: 'Enter password',
                okText: 'Continue'
            });
            if (!password) {
                await showAlert('Save cancelled - no password provided.', '⚠️ Cancelled');
                return;
            }
            
            const confirmPassword = await showPrompt('Confirm your password:', '🔑 Confirm Password', { 
                inputType: 'password', 
                placeholder: 'Re-enter password',
                okText: 'Encrypt & Save'
            });
            if (password !== confirmPassword) {
                await showAlert('Passwords do not match. Save cancelled.', '❌ Error');
                return;
            }
            
            sessionEncryptionPassword = password;
            autosaveEncrypted = true;
            persistEncryptionState(); // Persist immediately after setting password
            populateCategoryDropdowns(); // Update dropdowns to show Private category
            
            try {
                const encryptedContent = await encryptData(dataStr, password);
                finalData = JSON.stringify({
                    encrypted: true,
                    version: 1,
                    data: encryptedContent
                });
                fileName = `${safeName}-notes-${dateStr}.encrypted.json`;
            } catch (error) {
                console.error('Encryption error:', error);
                await showAlert('Encryption failed. Saving as plain JSON instead.', '⚠️ Warning');
                finalData = dataStr;
                fileName = `${safeName}-notes-${dateStr}.json`;
                autosaveEncrypted = false;
                populateCategoryDropdowns(); // Update dropdowns to hide Private category
            }
        } else {
            finalData = dataStr;
            fileName = `${safeName}-notes-${dateStr}.json`;
            autosaveEncrypted = false;
            populateCategoryDropdowns(); // Update dropdowns to hide Private category
        }
    }
    
    const blob = new Blob([finalData], { type: 'application/json' });
    
    // If we already have a file handle from a previous save, write directly to it
    if (fileHandle) {
        try {
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            // Update last modified date on successful save
            lastModifiedDate = new Date().toISOString();
            updateFileInfoDisplay();
            persistEncryptionState(); // Persist state after successful save
            updateLastKnownDiskModified(); // Update conflict tracking
            hideSavingIndicator();
            return;
        } catch (err) {
            console.log('Could not write to existing file handle, will prompt for new location:', err);
            fileHandle = null; // Reset handle so we prompt for a new location
        }
    }
    
    // Use File System Access API if available (allows user to choose save location)
    if ('showSaveFilePicker' in window) {
        try {
            const handle = await window.showSaveFilePicker({
                id: 'notesExport', // Browser remembers last directory for this ID
                suggestedName: fileName,
                types: [{
                    description: 'JSON Files',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            
            // Store the file handle for autosave
            fileHandle = handle;
            
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            
            // Update file info after successful save
            currentFileName = handle.name;
            currentFilePath = ''; // Path not available from showSaveFilePicker
            lastModifiedDate = new Date().toISOString();
            updateFileInfoDisplay();
            
            // Enable autosave after successful first save
            autosaveEnabled = true;
            persistEncryptionState(); // Persist state after successful save
            
            // Initialize conflict tracking for the new file handle
            await initializeConflictTracking(handle);
            
            hideSavingIndicator();
            return;
        } catch (err) {
            // User cancelled the save dialog or API failed
            if (err.name === 'AbortError') {
                hideSavingIndicator();
                return; // User cancelled, do nothing
            }
            // Fall through to legacy download method
            console.log('File System Access API failed, falling back to download:', err);
        }
    }
    
    // Fallback: Legacy download method for browsers that don't support File System Access API
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // Update file info for legacy save
    currentFileName = fileName;
    currentFilePath = '';
    lastModifiedDate = new Date().toISOString();
    updateFileInfoDisplay();
    
    // Enable autosave even with legacy method (won't have file handle though)
    autosaveEnabled = true;
    persistEncryptionState(); // Persist state after save
    
    hideSavingIndicator();
}

// Change encryption setting
async function changeEncryptionSetting() {
    if (autosaveEncrypted) {
        // Currently encrypted, ask to disable
        const disable = await showConfirm('Encryption is currently ON.\n\nDo you want to disable encryption?\nFuture saves will be plain JSON.', '🔐 Encryption Settings');
        if (disable) {
            autosaveEncrypted = false;
            sessionEncryptionPassword = null;
            persistEncryptionState(); // Persist the change
            await showAlert('Encryption disabled. Future saves will be plain JSON.', '✅ Setting Changed');
        }
    } else {
        // Currently not encrypted, ask to enable
        const enable = await showConfirm('Encryption is currently OFF.\n\nDo you want to enable encryption?\nYou will need to set a password.', '🔐 Encryption Settings');
        if (enable) {
            const password = await showPrompt('Enter a password for encryption:', '🔑 Set Password', { 
                inputType: 'password', 
                placeholder: 'Enter password',
                okText: 'Continue'
            });
            if (!password) {
                await showAlert('Cancelled - no password provided.', '⚠️ Cancelled');
                return;
            }
            
            const confirmPassword = await showPrompt('Confirm your password:', '🔑 Confirm Password', { 
                inputType: 'password', 
                placeholder: 'Re-enter password',
                okText: 'Enable Encryption'
            });
            if (password !== confirmPassword) {
                await showAlert('Passwords do not match. Encryption not enabled.', '❌ Error');
                return;
            }
            
            sessionEncryptionPassword = password;
            autosaveEncrypted = true;
            persistEncryptionState(); // Persist the change
            populateCategoryDropdowns(); // Update dropdowns to show Private category
            await showAlert('Encryption enabled. Future saves will be encrypted.', '✅ Setting Changed');
        }
    }
}

// Wrapper to maintain backward compatibility with exportToJSON name
async function exportToJSON() {
    await saveToFile();
}

// Open file using File System Access API (preferred) or fallback to file input
async function openFile() {
    // Use File System Access API if available - this gives us a file handle for saving back
    if ('showOpenFilePicker' in window) {
        try {
            const [handle] = await window.showOpenFilePicker({
                id: 'notesImport',
                types: [{
                    description: 'JSON Files',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            
            const file = await handle.getFile();
            const content = await file.text();
            
            await processImportedFile(content, file.name, file.lastModified, handle);
        } catch (err) {
            if (err.name === 'AbortError') {
                // User cancelled, do nothing
                return;
            }
            console.log('File System Access API failed, falling back to file input:', err);
            // Fallback to traditional file input
            document.getElementById('importFile').click();
        }
    } else {
        // Fallback for browsers without File System Access API
        document.getElementById('importFile').click();
    }
}

// Fallback import from file input (for browsers without File System Access API)
async function importFromJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const fileInput = e.target;
    
    const reader = new FileReader();
    reader.onload = async function(event) {
        await processImportedFile(event.target.result, file.name, file.lastModified, null);
    };
    
    reader.readAsText(file);
    
    // Reset file input so the same file can be imported again
    fileInput.value = '';
}

// Process imported file content (shared by both import methods)
async function processImportedFile(content, fileName, lastModified, handle) {
    try {
        let data = JSON.parse(content);
        let isEncryptedFile = false;
        let decryptionPassword = null;
        
        // Check if file is encrypted
        if (data.encrypted === true && data.data) {
            isEncryptedFile = true;
            const password = await showPrompt('This file is encrypted. Enter the password:', '🔐 Encrypted File', {
                inputType: 'password',
                placeholder: 'Enter password',
                okText: 'Decrypt'
            });
            if (!password) {
                await showAlert('Import cancelled - no password provided.', '⚠️ Cancelled');
                return;
            }
            
            try {
                const decryptedStr = await decryptData(data.data, password);
                data = JSON.parse(decryptedStr);
                decryptionPassword = password;
            } catch (decryptError) {
                console.error('Decryption error:', decryptError);
                await showAlert('Decryption failed. Wrong password or corrupted file.', '❌ Error');
                return;
            }
        }
        
        // Handle both formats: array of notes or object with notes property
        let importedNotes = [];
        let importedNotebookName = null;
        let importedCustomCategories = null;
        
        if (Array.isArray(data)) {
            importedNotes = data;
        } else if (data.notes && Array.isArray(data.notes)) {
            importedNotes = data.notes;
            importedNotebookName = data.notebookName;
            importedCustomCategories = data.customCategories;
        } else {
            throw new Error('Invalid format');
        }
        
        // Validate notes have required fields
        const validNotes = importedNotes.filter(note => 
            note.id && note.title && note.description
        );
        
        if (validNotes.length === 0) {
            await showAlert('No valid notes found in the file.', '❌ Error');
            return;
        }
        
        // Successfully parsed - now update state
        // Store the file handle for saving back to the same location
        fileHandle = handle;
        
        // Initialize conflict tracking for the opened file
        await initializeConflictTracking(handle);
        
        if (isEncryptedFile && decryptionPassword) {
            sessionEncryptionPassword = decryptionPassword;
            autosaveEncrypted = true;
        } else {
            // Non-encrypted import - clear encryption settings
            sessionEncryptionPassword = null;
            autosaveEncrypted = false;
        }
        
        // Persist encryption state after import
        persistEncryptionState();
        
        // Update category dropdowns (shows/hides Private category based on encryption)
        populateCategoryDropdowns();
        
        // Directly replace all notes with imported data (no prompts)
        notes = validNotes;
        
        // Replace custom categories if available
        if (importedCustomCategories && Array.isArray(importedCustomCategories)) {
            customCategories = importedCustomCategories;
        }
        
        // Update notebook name if provided
        if (importedNotebookName) {
            notebookName = importedNotebookName;
            document.getElementById('projectName').value = notebookName;
            document.title = `${notebookName} - Stack`;
        }
        
        // Update file info display
        currentFileName = fileName;
        currentFilePath = ''; // Path not available from file picker
        lastModifiedDate = new Date(lastModified).toISOString();
        
        // Enable autosave after import
        autosaveEnabled = true;
        
        // Refresh category dropdowns
        populateCategoryDropdowns();
        
        // Save all session data to IndexedDB
        saveToStorage();
        renderNotes();
        updateStats();
        checkDueSoon();
        dueSoonDismissed = false; // Reset dismissed state on import
        
        updateFileInfoDisplay();
    } catch (error) {
        console.error('Import error:', error);
        await showAlert('Failed to import file. Please ensure it is a valid JSON file with notes data.', '❌ Error');
    }
}

// Print to PDF
function printToPDF() {
    // Create a printable version
    const printWindow = window.open('', '_blank');
    
    // Get current filter to check if archive is selected
    const filterCategory = document.getElementById('filterCategory').value;
    const showArchived = filterCategory === 'archive';
    
    // Filter out archived notes unless archive filter is selected
    const printableNotes = notes.filter(note => {
        if (note.category === 'archive' && !showArchived) return false;
        // If a specific category filter is applied, only print that category
        if (filterCategory && note.category !== filterCategory) return false;
        return true;
    });
    
    const sortedNotes = [...printableNotes].sort((a, b) => {
        const numA = parseInt(a.id.replace('NOTE-', '')) || 0;
        const numB = parseInt(b.id.replace('NOTE-', '')) || 0;
        return numA - numB;
    });
    
    const avgRating = printableNotes.length > 0 
        ? (printableNotes.reduce((sum, n) => sum + n.rating, 0) / printableNotes.length).toFixed(1)
        : 0;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${notebookName} - Notes</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Arial, sans-serif; 
                    padding: 40px; 
                    color: #1e293b;
                    line-height: 1.6;
                }
                .header { 
                    text-align: center; 
                    margin-bottom: 30px; 
                    padding-bottom: 20px;
                    border-bottom: 2px solid #e2e8f0;
                }
                .header h1 { 
                    font-size: 24px; 
                    margin-bottom: 5px;
                    color: #1e293b;
                }
                .header .date { 
                    color: #64748b; 
                    font-size: 14px; 
                }
                .summary {
                    display: flex;
                    justify-content: center;
                    gap: 40px;
                    margin-bottom: 30px;
                    padding: 15px;
                    background: #f8fafc;
                    border-radius: 8px;
                }
                .summary-item {
                    text-align: center;
                }
                .summary-item .label {
                    font-size: 12px;
                    color: #64748b;
                    text-transform: uppercase;
                }
                .summary-item .value {
                    font-size: 20px;
                    font-weight: 600;
                    color: #4f46e5;
                }
                .note { 
                    margin-bottom: 25px; 
                    padding: 20px;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    page-break-inside: avoid;
                }
                .note-header { 
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 10px;
                }
                .note-id { 
                    font-size: 12px;
                    color: #64748b;
                    font-weight: 500;
                }
                .note-title { 
                    font-size: 16px; 
                    font-weight: 600;
                    margin: 5px 0 10px 0;
                }
                .note-description { 
                    color: #475569;
                    margin-bottom: 15px;
                    font-size: 14px;
                    white-space: pre-wrap;
                }
                .note-meta { 
                    display: flex;
                    flex-wrap: wrap;
                    gap: 15px;
                    font-size: 13px;
                    padding-top: 10px;
                    border-top: 1px solid #e2e8f0;
                }
                .meta-item {
                    display: flex;
                    gap: 5px;
                }
                .meta-label {
                    color: #64748b;
                }
                .meta-value {
                    font-weight: 500;
                }
                .badge {
                    display: inline-block;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 11px;
                    font-weight: 500;
                }
                .stars {
                    color: #f59e0b;
                    font-size: 14px;
                }
                .linked {
                    margin-top: 10px;
                    font-size: 13px;
                    color: #64748b;
                }
                a {
                    color: #4f46e5;
                    text-decoration: none;
                    word-break: break-all;
                }
                a:hover {
                    text-decoration: underline;
                }
                @media print {
                    body { padding: 20px; }
                    .note { break-inside: avoid; }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>${escapeHtml(notebookName)}</h1>
                <div class="date">Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
            
            <div class="summary">
                <div class="summary-item">
                    <div class="label">Total Notes</div>
                    <div class="value">${sortedNotes.length}</div>
                </div>
                <div class="summary-item">
                    <div class="label">Action Notes</div>
                    <div class="value">${sortedNotes.filter(n => n.category === 'action').length}</div>
                </div>
                <div class="summary-item">
                    <div class="label">Average Rating</div>
                    <div class="value">${avgRating} ★</div>
                </div>
                <div class="summary-item">
                    <div class="label">Completed</div>
                    <div class="value">${sortedNotes.filter(n => n.status === 'completed').length}</div>
                </div>
            </div>
            
            ${sortedNotes.map(note => `
                <div class="note">
                    <div class="note-header">
                        <div>
                            <div class="note-id">${note.id}</div>
                            <div class="note-title">${linkifyText(note.title)}</div>
                        </div>
                        <span class="stars">${getStarDisplay(note.rating)}</span>
                    </div>
                    <div class="note-description rich-text-content">${renderRichText(note.description)}</div>
                    <div class="note-meta">
                        <div class="meta-item">
                            <span class="meta-label">Category:</span>
                            <span class="meta-value">${formatCategory(note.category)}</span>
                        </div>
                        ${hasActionControls(note.category) && note.status ? `
                        <div class="meta-item">
                            <span class="meta-label">Status:</span>
                            <span class="meta-value">${formatStatus(note.status)}</span>
                        </div>
                        ` : ''}
                        <div class="meta-item">
                            <span class="meta-label">Updated:</span>
                            <span class="meta-value">${formatDate(note.updatedAt)}</span>
                        </div>
                    </div>
                    ${note.linkedNotes?.length ? `
                        <div class="linked">
                            <strong>Linked:</strong> ${note.linkedNotes.join(', ')}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </body>
        </html>
    `;
    
    printWindow.document.write(html);
    printWindow.document.close();
    
    // Wait for content to load then print
    printWindow.onload = function() {
        printWindow.print();
    };
}

// Local Storage (now uses IndexedDB per session)
function saveToStorage() {
    saveSessionData().catch(err => console.error('Failed to save session data:', err));
}

function saveCustomCategories() {
    saveSessionData().catch(err => console.error('Failed to save custom categories:', err));
}

// loadCustomCategories is now handled in loadFromStorage

// Get all categories (default + custom)
function getAllCategories() {
    const custom = customCategories.map(cat => ({
        value: cat.toLowerCase().replace(/\\s+/g, '-'),
        label: cat,
        isCustom: true
    }));
    
    // Filter out encrypted-only categories if file is not encrypted
    const defaultCats = DEFAULT_CATEGORIES.filter(cat => {
        if (cat.encryptedOnly && !autosaveEncrypted) {
            return false; // Hide private category when not encrypted
        }
        return true;
    });
    
    return [...defaultCats, ...custom];
}

// Populate all category dropdowns
function populateCategoryDropdowns() {
    const categories = getAllCategories();
    
    // Count notes per category
    const categoryCounts = {};
    notes.forEach(note => {
        const cat = note.category || 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    
    // Filter dropdown (with counts)
    const filterSelect = document.getElementById('filterCategory');
    if (filterSelect) {
        const currentValue = filterSelect.value;
        const totalCount = notes.length;
        filterSelect.innerHTML = `<option value="">All Categories (${totalCount})</option>` + 
            categories.map(cat => {
                const count = categoryCounts[cat.value] || 0;
                return `<option value="${cat.value}">${cat.label} (${count})</option>`;
            }).join('');
        filterSelect.value = currentValue;
    }
    
    // Form dropdown (no counts needed)
    const formSelect = document.getElementById('reqCategory');
    if (formSelect) {
        const currentValue = formSelect.value;
        formSelect.innerHTML = categories.map(cat => 
            `<option value="${cat.value}">${cat.label}</option>`
        ).join('');
        formSelect.value = currentValue || 'personal';
    }
}

// Populate status filter dropdown with counts
function populateStatusFilter() {
    const filterSelect = document.getElementById('filterStatus');
    if (!filterSelect) return;
    
    const currentValue = filterSelect.value;
    
    // Count notes per status (only for notes with action controls)
    const statusCounts = {
        'not-started': 0,
        'in-progress': 0,
        'completed': 0,
        'deferred': 0,
        'cancelled': 0
    };
    
    let totalWithStatus = 0;
    notes.forEach(note => {
        if (hasActionControls(note.category) && note.status) {
            statusCounts[note.status] = (statusCounts[note.status] || 0) + 1;
            totalWithStatus++;
        }
    });
    
    filterSelect.innerHTML = `
        <option value="">All Statuses (${totalWithStatus})</option>
        <option value="not-started">Not Started (${statusCounts['not-started']})</option>
        <option value="in-progress">In Progress (${statusCounts['in-progress']})</option>
        <option value="completed">Completed (${statusCounts['completed']})</option>
        <option value="deferred">Deferred (${statusCounts['deferred']})</option>
        <option value="cancelled">Cancelled (${statusCounts['cancelled']})</option>
    `;
    filterSelect.value = currentValue;
}

// Add custom category
async function addCustomCategory() {
    const name = await showPrompt('Enter new category name:', '➕ Add Category', {
        placeholder: 'e.g., Research, Travel, Health...',
        okText: 'Add'
    });
    
    if (!name || !name.trim()) return;
    
    const trimmedName = name.trim();
    const value = trimmedName.toLowerCase().replace(/\\s+/g, '-');
    
    // Check for duplicates
    const allCategories = getAllCategories();
    if (allCategories.some(cat => cat.value === value || cat.label.toLowerCase() === trimmedName.toLowerCase())) {
        await showAlert('This category already exists.', '⚠️ Duplicate');
        return;
    }
    
    // Check length
    if (trimmedName.length > 20) {
        await showAlert('Category name must be 20 characters or less.', '⚠️ Too Long');
        return;
    }
    
    customCategories.push(trimmedName);
    saveCustomCategories();
    populateCategoryDropdowns();
    updateCategoryManagementList();
    updateStats();
    await showAlert(`Category "${trimmedName}" added!`, '✅ Success');
}

// Delete custom category
async function deleteCustomCategory(categoryName) {
    const value = categoryName.toLowerCase().replace(/\\s+/g, '-');
    
    // Check if any notes use this category
    const notesUsingCategory = notes.filter(n => n.category === value);
    
    if (notesUsingCategory.length > 0) {
        const reassign = await showConfirm(
            `${notesUsingCategory.length} note(s) use this category.\n\nYes = Reassign to "Personal" and delete\nNo = Cancel`,
            '⚠️ Category In Use'
        );
        if (!reassign) return;
        
        // Reassign notes
        notesUsingCategory.forEach(note => {
            note.category = 'personal';
        });
        saveToStorage();
        triggerAutosave();
        renderNotes();
    }
    
    customCategories = customCategories.filter(cat => cat !== categoryName);
    saveCustomCategories();
    populateCategoryDropdowns();
    updateCategoryManagementList();
    updateStats();
}

// Update the category list in management modal
function updateCategoryManagementList() {
    const listContainer = document.getElementById('categoryList');
    if (!listContainer) return;
    
    const allCategories = getAllCategories();
    
    listContainer.innerHTML = allCategories.map(cat => {
        const noteCount = notes.filter(n => n.category === cat.value).length;
        const deleteBtn = cat.isCustom 
            ? `<button class="btn btn-sm btn-danger" onclick="deleteCustomCategory('${cat.label}')">Delete</button>`
            : '<span class="default-badge">Default</span>';
        
        return `
            <div class="category-item">
                <span class="category-name">${cat.label}</span>
                <span class="category-count">${noteCount} note${noteCount !== 1 ? 's' : ''}</span>
                ${deleteBtn}
            </div>
        `;
    }).join('');
}

// Show category management modal
function showCategoryManagement() {
    const modal = document.getElementById('categoryModal');
    if (modal) {
        updateCategoryManagementList();
        modal.classList.add('active');
    }
}

// Close category management modal
function closeCategoryManagement() {
    const modal = document.getElementById('categoryModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function loadFromStorage() {
    try {
        const sessionData = await loadSessionData();
        if (sessionData) {
            notes = sessionData.notes || [];
            notebookName = sessionData.notebookName || 'My Notebook';
            customCategories = sessionData.customCategories || [];
            currentFileName = sessionData.currentFileName || null;
            currentFilePath = sessionData.currentFilePath || null;
            lastModifiedDate = sessionData.lastModifiedDate || null;
            autosaveEnabled = sessionData.autosaveEnabled || false;
            autosaveEncrypted = sessionData.autosaveEncrypted || false;
            
            // Restore encryption password from sessionStorage if available
            restoreEncryptionState();
        } else {
            // New session - start fresh with empty state
            notes = [];
            notebookName = 'My Notebook';
            customCategories = [];
            currentFileName = null;
            currentFilePath = null;
            lastModifiedDate = null;
            autosaveEnabled = false;
            autosaveEncrypted = false;
        }
    } catch (e) {
        console.error('Failed to load from IndexedDB:', e);
        notes = [];
    }
}

// Sample Data
function loadSampleData() {
    notes = [
        {
            id: 'NOTE-001',
            title: '[SAMPLE] Welcome to Notes Organizer!',
            description: 'This is a sample note to help you get started. Edit or delete this note and create your own!\n\nYou can organize notes by categories:\n• Personal - for personal thoughts\n• Work - for work-related notes\n• Ideas - for creative ideas\n• Learning - for study notes\n• Action - for tasks with status tracking\n\nYou can add links like https://example.com in text fields.',
            category: 'personal',
            rating: 5,
            status: null,
            linkedNotes: [],
            notes: 'Delete this sample and start adding your own notes!',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        },
        {
            id: 'NOTE-002',
            title: '[SAMPLE] Action Note Example',
            description: 'This is an example of an Action note. Action notes have status tracking so you can mark them as:\n• Not Started\n• In Progress\n• Completed\n• Deferred\n• Cancelled',
            category: 'action',
            rating: 4,
            status: 'in-progress',
            linkedNotes: ['NOTE-001'],
            notes: 'Action notes are great for tracking tasks and to-dos!',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }
    ];
    saveToStorage();
}

// Theme Functions
function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme();
    saveGlobalSetting('theme', currentTheme).catch(err => console.error('Failed to save theme:', err));
}

async function loadTheme() {
    try {
        const savedTheme = await loadGlobalSetting('theme');
        if (savedTheme) {
            currentTheme = savedTheme;
        } else {
            // Check system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                currentTheme = 'dark';
            }
        }
    } catch (e) {
        console.error('Failed to load theme:', e);
    }
    applyTheme();
}

function applyTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
}

// Notebook Name Functions
function saveNotebookName() {
    notebookName = document.getElementById('projectName').value.trim() || 'My Notebook';
    document.title = `${notebookName} - Stack`;
    saveSessionData().catch(err => console.error('Failed to save notebook name:', err));
}

function loadNotebookNameFromState() {
    // notebookName is already loaded from session data in loadFromStorage
    document.getElementById('projectName').value = notebookName;
    document.title = `${notebookName} - Stack`;
}

// Utility Functions
function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatCategory(category) {
    // Check if it's a custom category - return original name with preserved casing
    const customCat = customCategories.find(cat => cat.toLowerCase().replace(/\s+/g, '-') === category);
    if (customCat) {
        return customCat; // Return the original name as entered by user
    }
    // For default categories, format normally
    return category.split('-').map(capitalizeFirst).join(' ');
}

function formatStatus(status) {
    return status.split('-').map(capitalizeFirst).join(' ');
}

function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

function formatDueDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

function isDueDateOverdue(dateStr, status, progress) {
    if (!dateStr || status === 'completed' || status === 'cancelled') return false;
    if (progress >= 100) return false; // 100% complete is not overdue
    const dueDate = new Date(dateStr + 'T23:59:59');
    return dueDate < new Date();
}

function isDueDateSoon(dateStr, status, progress) {
    if (!dateStr) return false;
    if (status === 'completed' || status === 'cancelled') return false;
    if (progress >= 100) return false; // 100% complete is not due soon
    const dueDate = new Date(dateStr + 'T23:59:59');
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    return dueDate > now && dueDate <= threeDaysFromNow;
}

function getProgressClass(percentage) {
    if (percentage >= 100) return 'progress-complete';
    if (percentage >= 70) return 'progress-high';
    if (percentage >= 30) return 'progress-medium';
    return 'progress-low';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Render rich text HTML content (from Quill editor) - no escaping needed
function renderRichText(html) {
    if (!html) return '';
    // Fix links that don't have a protocol (e.g., google.com -> https://google.com)
    // This handles Quill editor links that were entered without https://
    return html.replace(/href="(?!(https?:\/\/|mailto:|tel:|#|\/))([^"]+)"/gi, (match, p1, url) => {
        return `href="https://${url}"`;
    });
}

function linkifyText(text) {
    if (!text) return '';
    // First escape HTML to prevent XSS
    const escaped = escapeHtml(text);
    
    // First handle markdown-style links [text](url)
    const markdownLinkPattern = /\[([^\]]+)\]\(((https?:\/\/|www\.)[^\s)]+)\)/gi;
    let result = escaped.replace(markdownLinkPattern, (match, linkText, url) => {
        const href = url.startsWith('www.') ? 'https://' + url : url;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-link">${linkText}</a>`;
    });
    
    // Then handle plain URLs (that aren't already in links)
    // URL regex pattern - matches http://, https://, and www.
    const urlPattern = /(https?:\/\/[^\s<]+[^\s<.,;:!?"'()\[\]{}])|(www\.[^\s<]+[^\s<.,;:!?"'()\[\]{}])/gi;
    // Replace URLs with clickable links (but not if already inside an href or anchor tag)
    result = result.replace(urlPattern, (match, p1, p2, offset, string) => {
        // Check if this URL is already part of an anchor tag
        const before = string.substring(Math.max(0, offset - 10), offset);
        if (before.includes('href="') || before.includes('>')) {
            return match;
        }
        const href = match.startsWith('www.') ? 'https://' + match : match;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-link">${match}</a>`;
    });
    
    // Convert newlines to <br> for proper display
    result = result.replace(/\n/g, '<br>');
    
    return result;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ========== PRIVACY MODE ==========

let privacyMode = false;
let tapCount = 0;
let tapTimer = null;

async function loadPrivacyMode() {
    // Load saved state from global settings
    try {
        const savedPrivacy = await loadGlobalSetting('privacyMode');
        if (savedPrivacy === true) {
            enablePrivacyMode();
        }
    } catch (e) {
        console.error('Failed to load privacy mode:', e);
    }
    
    // Shift+Enter to disable privacy mode (desktop)
    document.addEventListener('keydown', (e) => {
        if (privacyMode && e.shiftKey && e.key === 'Enter') {
            e.preventDefault();
            disablePrivacyMode();
        }
    });
    
    // Double-tap/click to disable privacy mode (mobile)
    const overlay = document.getElementById('privacyOverlay');
    
    const handleTap = (e) => {
        // Only work on touch devices
        if (!('ontouchstart' in window)) return;
        
        tapCount++;
        
        if (tapCount === 1) {
            tapTimer = setTimeout(() => {
                tapCount = 0;
            }, 500);
        } else if (tapCount === 2) {
            clearTimeout(tapTimer);
            tapCount = 0;
            e.preventDefault();
            disablePrivacyMode();
        }
    };
    
    overlay?.addEventListener('click', handleTap);
}

function enablePrivacyMode() {
    privacyMode = true;
    document.getElementById('privacyOverlay')?.classList.add('active');
    saveGlobalSetting('privacyMode', true).catch(err => console.error('Failed to save privacy mode:', err));
}

function disablePrivacyMode() {
    privacyMode = false;
    document.getElementById('privacyOverlay')?.classList.remove('active');
    saveGlobalSetting('privacyMode', false).catch(err => console.error('Failed to save privacy mode:', err));
}
