
// CONSTANTS & SETTINGS

const SETTINGS = {
  relationshipTag: "contact",
  dataFolder: "@CRM",
}

const PLUGIN_ID = "np.jokky102.crm"

// Reads a setting from DataStore.settings, falling back to defaultValue
function getSetting(key, defaultValue) {
  const value = DataStore.settings[key]
  if (value !== undefined && value !== null && String(value) !== "") return value
  return defaultValue
}

const INTERACTION_TYPES = {
  call: "☎️ Call",
  email: "📧 Email",
  meeting: "🤝 Meeting",
  text: "💬 Text",
  social: "📱 Social",
  other: "📝 Other",
}

const REMINDER_FREQUENCIES = {
  day: "Every day",
  week: "Every week",
  twoWeeks: "Every 2 weeks",
  threeWeeks: "Every 3 weeks",
  month: "Every month",
  twoMonths: "Every 2 months",
  quarter: "Every 3 months",
  sixMonths: "Every 6 months",
  year: "Every year",
}

const WINDOW_ID = "np.jokky102.crm.main"

// MAIN COMMANDS

async function addRelationship() {
  try {
    // invokePluginCommandByName expects a return value; return {} to suppress log errors
    const name = await CommandBar.showInput(
      "Contact Name",
      "Create Contact '%@'"
    )
    if (!name) return

    const category = await CommandBar.showOptions(
      ["Client", "Colleague", "Friend", "Family", "Business", "Other"],
      "Select category for " + name
    )

    const reminderFreq = await CommandBar.showOptions(
      Object.values(REMINDER_FREQUENCIES),
      "How often should you connect?"
    )

    const reminderFreqKey = Object.keys(REMINDER_FREQUENCIES)[reminderFreq.index]
    const frequencyText = Object.values(REMINDER_FREQUENCIES)[reminderFreq.index]

    const tagPrefix = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)
    const noteContent = createContactNote(
      name,
      category.value,
      frequencyText,
      reminderFreqKey,
      tagPrefix
    )

    const filename = DataStore.newNoteWithContent(
      noteContent,
      SETTINGS.dataFolder,
      `${name.replace(/[\/\\:*?"<>|]/g, "")}.md`
    )

    scheduleNextReminder(name, reminderFreqKey, filename)

    await CommandBar.prompt(
      "Contact created!",
      `${name} has been added to your CRM`,
      ["OK"]
    )
    
    // Refresh dashboard if open, otherwise do nothing
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error creating contact: ${error.message}`)
    return {}
  }
}

async function showCRMDashboard() {
  try {
    const contacts = await getRelationships()
    const html = getCRMDashboardHTML(contacts)

    await HTMLView.showInMainWindow(html, "CRM Dashboard", {
      customId: WINDOW_ID,
      splitView: false,
      icon: "users",
      iconColor: "blue-500",
      autoTopPadding: true,
    })
  } catch (error) {
    console.log(`❌ Error showing dashboard: ${error.message}`)
  }
}

// Base function: log interaction without creating a reminder
async function logInteractionBase(contact) {
  try {
    const interactionType = await CommandBar.showOptions(
      Object.values(INTERACTION_TYPES),
      "How did you interact?"
    )

    const notes = await CommandBar.showInput(
      "Interaction notes",
      "Add notes: '%@'"
    )

    // Reads the note directly without opening it in the editor
    const note = DataStore.projectNoteByFilename(contact.filename)
    if (!note) {
      console.log(`❌ Could not open note: ${contact.filename}`)
      return false
    }

    const interaction = `${formatDateTime(new Date())} ${interactionType.value} - ${notes || "No notes"}`
    let interactionPosition = getSetting("crm-interaction-position", "append")
    if (typeof interactionPosition === "boolean") {
      interactionPosition = interactionPosition ? "prepend" : "append"
    }
    if (interactionPosition === "prepend") {
      // Insert after the "## Interactions" heading if it exists, otherwise at the top
      const interactionsHeading = note.paragraphs.find(
        p => p.type === "title" && p.content.trim() === "Interactions"
      )
      if (interactionsHeading) {
        note.insertParagraph(interaction, interactionsHeading.lineIndex + 1, "list")
      } else {
        note.prependParagraph(interaction, "list")
      }
    } else {
      note.appendParagraph(interaction, "list")
    }

    note.content = updateFrontmatterKey(note.content, "last_contact", formatDate(new Date()))

    return true
  } catch (error) {
    console.log(`❌ Error logging interaction: ${error.message}`)
    return false
  }
}

// Command 1: Log interaction only (no reminder)
async function addInteraction() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact"
    )
    const contact = contacts[contactChoice.index]

    const success = await logInteractionBase(contact)
    if (!success) return

    await CommandBar.prompt(
      "Interaction logged!",
      `Added interaction for ${contact.name}`,
      ["OK"]
    )

    // ✅ Navigate to the contact note only if the preference is enabled
    const navigateAfterInteraction = getSetting("crm-navigate-after-interaction", "true")
    if (navigateAfterInteraction !== "false") {
      await Editor.openNoteByFilename(contact.filename)
    }

    // ✅ If the dashboard is open, refresh it in the background without navigating to it
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error adding interaction: ${error.message}`)
    return {}
  }
}

// Command 2: Log interaction AND schedule next reminder
async function logInteractionWithReminder() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact"
    )
    const contact = contacts[contactChoice.index]

    const success = await logInteractionBase(contact)
    if (!success) return

    // ✅ Complete the contact's reminder for today
    await completeContactReminder(contact.name)

    // ✅ Create the next reminder if configured
    const hasValidFreqKey = contact.frequencyKey && contact.frequencyKey.trim() !== ""
    if (hasValidFreqKey) {
      try {
        const nextDate = getNextReminderDate(contact.frequencyKey)
        scheduleCalendarReminder(`Follow up with ${contact.name}`, nextDate, contact.filename)
      } catch (reminderError) {
        console.log(`❌ Error creating reminder: ${reminderError.message}`)
      }
    }

    await CommandBar.prompt(
      "Interaction logged!",
      `Added interaction for ${contact.name} with reminder scheduled`,
      ["OK"]
    )

    // ✅ Navigate to the contact note only if the preference is enabled
    const navigateAfterInteraction = getSetting("crm-navigate-after-interaction", "true")
    if (navigateAfterInteraction !== "false") {
      await Editor.openNoteByFilename(contact.filename)
    }

    // ✅ If the dashboard is open, refresh it in the background without navigating to it
    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error adding interaction with reminder: ${error.message}`)
    return {}
  }
}

async function setReminder() {
  try {
    const contacts = await getRelationships()
    if (contacts.length === 0) {
      await CommandBar.prompt("No contacts", "Create a Contact first.", ["OK"])
      return
    }

    const contactChoice = await CommandBar.showOptions(
      contacts.map((c) => c.name),
      "Select contact to remind"
    )
    const contact = contacts[contactChoice.index]

    const reminderType = await CommandBar.showOptions(
      ["Today", "Tomorrow", "Next week", "In 2 weeks", "Next month"],
      "When do you want to connect?"
    )

    const offsetDays = [0, 1, 7, 14, 30]
    const reminderDate = new Date()
    reminderDate.setDate(reminderDate.getDate() + offsetDays[reminderType.index])

    const reminderText = await CommandBar.showInput(
      "What's the reminder?",
      "Reminder: '%@'"
    )

    scheduleCalendarReminder(
      `${contact.name}: ${reminderText || "Follow up"}`,
      reminderDate,
      contact.filename
    )

    await CommandBar.prompt(
      "Reminder set!",
      `Reminder for ${contact.name} set`,
      ["OK"]
    )

    await refreshDashboardIfOpen()
    return {}
  } catch (error) {
    console.log(`❌ Error setting reminder: ${error.message}`)
    return {}
  }
}

async function updateSettings() {
  try {
    const currentTag = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)

    const tag = await CommandBar.showInput(
      "Relationship tag prefix",
      "Update tag to '%@'",
      currentTag
    )

    // Navigation setting after interaction
    const navigateChoice = await CommandBar.showOptions(
      ["✅ Yes – open contact note after logging interaction", "🚫 No – stay in current context"],
      "After logging an interaction, open the contact note?"
    )
    const navVal = navigateChoice.index === 0 ? "true" : "false"

    // Interaction date/time format setting
    const datetimeChoice = await CommandBar.showOptions(
      ["📅 Date Only", "🕐 Date + Time"],
      "Interaction timestamp format"
    )
    const dtVal = datetimeChoice.index === 0 ? "Date Only" : "Date + Time"

    // Interaction position setting in the note
    const positionChoice = await CommandBar.showOptions(
      ["⬇️ Append – newest at the bottom", "⬆️ Prepend – newest at the top"],
      "Where to add new interactions in the contact note?"
    )
    const posVal = positionChoice.index === 0 ? "append" : "prepend"

    // Reminder list picker
    const reminderLists = Calendar.availableReminderListTitles()
    const currentList = getSetting("crm-reminder-list", "")
    const listOptions = ["⬜ Default (system default)", ...reminderLists.map(l => (l === currentList ? "✅ " : "") + l)]
    const listChoice = await CommandBar.showOptions(listOptions, "Which Reminders list should CRM use?")
    const listVal = listChoice.index === 0 ? "" : reminderLists[listChoice.index - 1]

    // Save settings via DataStore.settings
    DataStore.settings = {
      ...DataStore.settings,
      "crm-relationship-tag": tag || DataStore.settings["crm-relationship-tag"] || SETTINGS.relationshipTag,
      "crm-navigate-after-interaction": navVal,
      "crm-interaction-datetime": dtVal,
      "crm-interaction-position": posVal,
      "crm-reminder-list": listVal,
    }

    await refreshDashboardIfOpen()
  } catch (error) {
    console.log(`❌ Error updating settings: ${error.message}`)
  }
}

// HELPER FUNCTIONS

function getRelationships() {
  try {
    
    const folderNotes = DataStore.projectNotes.filter(
      (n) => n.filename && n.filename.startsWith(SETTINGS.dataFolder + "/")
    )

    // Get the current tag prefix from settings
    const tagPrefix = getSetting("crm-relationship-tag", SETTINGS.relationshipTag)
    const requiredTag = `#${tagPrefix}/`

    const relationships = folderNotes
      .map((note) => {
        // Verify that it is a valid contact (has the configured tag)
        if (!note.content.includes(requiredTag)) return null
        const rel = parseContactNote(note)
        if (!rel) return null
        return { name: note.title, filename: note.filename, ...rel }
      })
      .filter(Boolean)

    return relationships
  } catch (error) {
    console.log(`❌ Error getting relationships: ${error.message}`)
    return []
  }
}

// Returns {key: value} for all fields in a YAML frontmatter block
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w_-]+):\s*(.*)$/)
    if (kv) result[kv[1]] = kv[2].trim()
  }
  return result
}

// Returns note.content with a frontmatter key updated (or added)
function updateFrontmatterKey(content, key, value) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return content
  const existing = new RegExp(`^${key}:.*$`, "m")
  const updated = existing.test(fm[1])
    ? fm[1].replace(existing, `${key}: ${value}`)
    : fm[1] + `\n${key}: ${value}`
  return content.replace(fm[0], `---\n${updated}\n---`)
}

function parseContactNote(note) {
  try {
    const fm = parseFrontmatter(note.content)
    return {
      category: fm.category || "",
      frequency: fm.frequency || "",
      frequencyKey: fm.frequency_key || "",
      lastContact: fm.last_contact || "",
    }
  } catch (error) {
    console.log(`⚠️ Error parsing contact note: ${error.message}`)
    return null
  }
}

function createContactNote(name, category, frequency, frequencyKey, tagPrefix) {
  const tag = tagPrefix || SETTINGS.relationshipTag
  return `---
category: ${category}
frequency: ${frequency}
frequency_key: ${frequencyKey}
last_contact: Never
---
# ${name}

#${tag}/${category}

## Interactions
`
}

function scheduleCalendarReminder(title, date, noteFilename) {
  try {
    const list = getSetting("crm-reminder-list", "")
    const item = CalendarItem.create(
      title, date, null, "reminder", false, list || "", false,
      `From CRM: ${noteFilename}`
    )
    Calendar.add(item)
  } catch (error) {
    console.log(`❌ Error scheduling reminder: ${error.message}`)
  }
}

function scheduleNextReminder(contactName, frequencyKey, noteFilename) {
  const date = getNextReminderDate(frequencyKey)
  const filename = noteFilename || `${SETTINGS.dataFolder}/${contactName}.md`
  scheduleCalendarReminder(`Follow up with ${contactName}`, date, filename)
}

async function completeContactReminder(contactName) {
  try {
    // Search in a wide range: from 2 years ago to 2 years in the future
    // This ensures any reminder for the contact, even future ones, is completed
    const from = new Date()
    from.setFullYear(from.getFullYear() - 2)
    const to = new Date()
    to.setFullYear(to.getFullYear() + 2)

    const allReminders = await Calendar.remindersBetween(from, to, '')
    
    const contactReminders = allReminders.filter((r) =>
      r.title.toLowerCase().includes(contactName.toLowerCase()) &&
      !r.isCompleted
    )

    for (const reminder of contactReminders) {
      reminder.isCompleted = true
      await Calendar.update(reminder)
    }
  } catch (error) {
    console.log(`⚠️ Could not complete reminder: ${error.message}`)
  }
}

async function refreshDashboard() {
  try {
    const contacts = await getRelationships()
    const html = getCRMDashboardHTML(contacts)
    await HTMLView.showInMainWindow(html, "CRM Dashboard", {
      customId: WINDOW_ID,
      splitView: false,
      icon: "users",
      iconColor: "blue-500",
      autoTopPadding: true,
    })
  } catch (error) {
    console.log(`⚠️ Could not refresh dashboard: ${error.message}`)
  }
}

// Refresh the dashboard only if it is already open, without navigating to it
async function refreshDashboardIfOpen() {
  try {
    const dashWindow = NotePlan.htmlWindows.find(w => w.customId === WINDOW_ID)
    if (!dashWindow) return
    const contacts = await getRelationships()
    const contactsJSON = JSON.stringify(contacts || [])
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
    const reminderList = getSetting("crm-reminder-list", "")
    const reminderListJSON = JSON.stringify(reminderList)
    await dashWindow.runJavaScript(
      "if (typeof updateContacts === 'function') { updateContacts(" + contactsJSON + ", " + reminderListJSON + "); }"
    )
  } catch (error) {
    console.log(`⚠️ Could not refresh dashboard in place: ${error.message}`)
  }
}

function getNextReminderDate(frequencyKey) {
  const date = new Date()
  const frequencyMap = {
    day: 1,
    week: 7,
    twoWeeks: 14,
    threeWeeks: 21,
    month: 30,
    twoMonths: 60,
    quarter: 90,
    sixMonths: 180,
    year: 365,
  }
  date.setDate(date.getDate() + (frequencyMap[frequencyKey] || 30))
  return date
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatDateTime(date) {
  let value = getSetting("crm-interaction-datetime", "Date + Time")
  if (typeof value === "boolean" || value === "true" || value === "false") {
    value = (value === true || value === "true") ? "Date + Time" : "Date Only"
  }
  const showTime = value === "Date + Time"
  const dateStr = formatDate(date)
  if (!showTime) return dateStr
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${dateStr} | ${hours}:${minutes}`
}

// CRM DASHBOARD HTML

function getCRMDashboardHTML(contacts) {
  const contactsJSON = JSON.stringify(contacts || [])
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")

  const reminderList = getSetting("crm-reminder-list", "")
  const reminderListJSON = JSON.stringify(reminderList)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CRM Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
      background-color: #fff;
      color: #333;
      padding: 20px;
    }
    @media (prefers-color-scheme: dark) {
      body { background-color: #1c1c1e; color: #f5f5f5; }
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 28px; margin-bottom: 6px; font-weight: 700; }
    .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }

    .action-buttons {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
      margin-bottom: 28px;
      padding: 16px;
      background: #f5f5f7;
      border-radius: 10px;
    }
    @media (prefers-color-scheme: dark) {
      .action-buttons { background: #2c2c2e; }
    }
    
    .btn {
      padding: 10px 16px;
      background: #007AFF;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #0051D5; }
    .btn:active { background: #003FA8; }
    
    .btn-secondary {
      background: #666;
    }
    .btn-secondary:hover { background: #555; }
    .btn-secondary:active { background: #444; }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: #f5f5f7;
      padding: 16px 20px;
      border-radius: 10px;
      text-align: center;
    }
    @media (prefers-color-scheme: dark) { .stat-card { background: #2c2c2e; } }
    .stat-value { font-size: 26px; font-weight: 700; color: #007AFF; }
    .stat-label { font-size: 11px; color: #888; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; }

    .section { margin-bottom: 32px; }
    .section-title {
      font-size: 16px; font-weight: 700;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #007AFF;
    }

    .list { display: flex; flex-direction: column; gap: 8px; }

    .card {
      background: #f5f5f7;
      padding: 14px 16px;
      border-radius: 8px;
      border-left: 4px solid #007AFF;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card:hover { background: #ececf0; }
    @media (prefers-color-scheme: dark) {
      .card { background: #2c2c2e; }
      .card:hover { background: #3a3a3d; }
    }

    .card-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .card-meta { font-size: 12px; color: #888; display: flex; gap: 14px; flex-wrap: wrap; }

    .empty { text-align: center; color: #888; padding: 32px 20px; font-size: 14px; }
    .loading { text-align: center; padding: 20px; color: #888; }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .filter-btn {
      padding: 5px 12px;
      border: 1.5px solid #007AFF;
      border-radius: 20px;
      background: transparent;
      color: #007AFF;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .filter-btn:hover { background: #e5f0ff; }
    .filter-btn.active { background: #007AFF; color: white; }
    @media (prefers-color-scheme: dark) {
      .filter-btn { color: #4da3ff; border-color: #4da3ff; }
      .filter-btn:hover { background: #1a2f4a; }
      .filter-btn.active { background: #4da3ff; color: #1c1c1e; }
    }
  </style>
</head>
<body>
<div class="container">

  <div class="action-buttons">
    <button class="btn" onclick="addInteractionFromDashboard()">📝 Log Interaction</button>
    <button class="btn" onclick="addInteractionWithReminderFromDashboard()">🔔 Log & Remind</button>
    <button class="btn" onclick="addReminderFromDashboard()">⏰ Set Reminder</button>
    <button class="btn" onclick="addContactFromDashboard()">👤 Add Contact</button>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-value" id="totalContacts">—</div>
      <div class="stat-label">Contacts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="upcomingReminders">—</div>
      <div class="stat-label">This Week</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" id="overdueCount">—</div>
      <div class="stat-label">Overdue</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">📅 Upcoming Reminders</div>
    <div class="list" id="reminders">
      <div class="loading">Loading…</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">👥 Contacts</div>
    <div class="filter-bar" id="categoryFilters"></div>
    <div class="list" id="contacts">
      <div class="loading">Loading…</div>
    </div>
  </div>
</div>

<script>
  // Data injected by the plugin
  var CONTACTS = ${contactsJSON};
  var REMINDER_LIST = ${reminderListJSON};
  var activeFilter = 'All';

  // ──────────────────────────────────────────────────────────────────────────
  // CATEGORY FILTER
  // ──────────────────────────────────────────────────────────────────────────

  function buildCategoryFilters() {
    var categories = ['All'];
    CONTACTS.forEach(function(c) {
      if (c.category && categories.indexOf(c.category) === -1) {
        categories.push(c.category);
      }
    });

    var bar = document.getElementById('categoryFilters');
    if (categories.length <= 1) {
      bar.style.display = 'none';
      return;
    }

    var html = '';
    for (var i = 0; i < categories.length; i++) {
      var cat = categories[i];
      var cls = cat === activeFilter ? 'filter-btn active' : 'filter-btn';
      html += '<button class="' + cls + '" data-cat="' + esc(cat) + '">'
        + esc(cat) + '</button>';
    }
    bar.innerHTML = html;

    var btns = bar.querySelectorAll('.filter-btn');
    for (var j = 0; j < btns.length; j++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          setFilter(btn.getAttribute('data-cat'));
        });
      })(btns[j]);
    }
  }

  function setFilter(category) {
    activeFilter = category;
    buildCategoryFilters();
    renderContacts();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BUTTON FUNCTIONS
  // ──────────────────────────────────────────────────────────────────────────

  async function addInteractionFromDashboard() {
    await DataStore.invokePluginCommandByName('Log Interaction', 'np.jokky102.crm', []);
  }

  async function addInteractionWithReminderFromDashboard() {
    await DataStore.invokePluginCommandByName('Log Interaction & Schedule Reminder', 'np.jokky102.crm', []);
  }

  async function addReminderFromDashboard() {
    await DataStore.invokePluginCommandByName('Set Reminder', 'np.jokky102.crm', []);
  }

  async function addContactFromDashboard() {
    await DataStore.invokePluginCommandByName('Add Contact', 'np.jokky102.crm', []);
  }

  function openContact(el) {
    var filename = el.getAttribute('data-filename');
    if (filename) Editor.openNoteByFilename(filename);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────

  function renderContacts() {
    var el = document.getElementById('contacts');
    document.getElementById('totalContacts').textContent = CONTACTS.length;

    var filtered = activeFilter === 'All'
      ? CONTACTS
      : CONTACTS.filter(function(c) { return c.category === activeFilter; });

    if (filtered.length === 0) {
      el.innerHTML = CONTACTS.length === 0
        ? '<div class="empty">No contacts yet.<br>Use "Add Contact" button to create one.</div>'
        : '<div class="empty">No contacts in category "' + esc(activeFilter) + '".</div>';
      return;
    }

    el.innerHTML = filtered.map(function(c) {
      return '<div class="card" data-filename="' + esc(c.filename) + '" onclick="openContact(this)">' +
        '<div class="card-title">' + esc(c.name) + '</div>' +
        '<div class="card-meta">' +
          (c.category ? '<span>🏷️ ' + esc(c.category) + '</span>' : '') +
          '<span>📅 ' + esc(c.frequency || 'Monthly') + '</span>' +
          '<span>💬 Last: ' + esc(c.lastContact || 'Never') + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function renderReminders() {
    var el = document.getElementById('reminders');
    try {
      var now = new Date();
      var todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      var todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      // Overdue: from the oldest date to the end of yesterday (excluding today)
      var pastStart = new Date(todayStart);
      pastStart.setFullYear(pastStart.getFullYear() - 2);
      var yesterdayEnd = new Date(todayStart);
      yesterdayEnd.setMilliseconds(yesterdayEnd.getMilliseconds() - 1);

      function isCrmReminder(r) {
        if (!r.notes || !r.notes.startsWith('From CRM:')) return false;
        if (REMINDER_LIST && r.calendar !== REMINDER_LIST) return false;
        return !r.isCompleted;
      }

      var overdueRaw = (await Calendar.remindersBetween(pastStart, yesterdayEnd, '')).filter(isCrmReminder);

      // Upcoming: from today (inclusive) to the end of the week
      var endOfWeek = new Date(todayStart);
      endOfWeek.setDate(endOfWeek.getDate() + (6 - todayStart.getDay()));
      endOfWeek.setHours(23, 59, 59, 999);

      var upcoming = (await Calendar.remindersBetween(todayStart, endOfWeek, '')).filter(isCrmReminder);

      document.getElementById('upcomingReminders').textContent = upcoming.length;
      document.getElementById('overdueCount').textContent = overdueRaw.length;

      var html = '';

      // Show overdue at the top with red label
      if (overdueRaw.length > 0) {
        html += '<div style="font-size:11px;font-weight:700;color:#FF3B30;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">⚠️ Overdue</div>';
        html += overdueRaw.map(function(r) {
          return '<div class="card" style="border-left:3px solid #FF3B30;">' +
            '<div class="card-title">' + esc(r.title) + '</div>' +
            '<div class="card-meta"><span style="color:#FF3B30;">' + new Date(r.date).toLocaleDateString() + '</span></div>' +
          '</div>';
        }).join('');
      }

      // Show upcoming
      if (upcoming.length > 0) {
        if (overdueRaw.length > 0) {
          html += '<div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px;">📅 This week</div>';
        }
        html += upcoming.map(function(r) {
          return '<div class="card">' +
            '<div class="card-title">' + esc(r.title) + '</div>' +
            '<div class="card-meta"><span>' + new Date(r.date).toLocaleDateString() + '</span></div>' +
          '</div>';
        }).join('');
      }

      if (html === '') {
        el.innerHTML = '<div class="empty">No reminders this week 🎉</div>';
      } else {
        el.innerHTML = html;
      }

    } catch (e) {
      el.innerHTML = '<div class="empty">Could not load reminders: ' + esc(e.message) + '</div>';
      document.getElementById('upcomingReminders').textContent = '?';
      document.getElementById('overdueCount').textContent = '?';
    }
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function init() {
    buildCategoryFilters();
    renderContacts();

    if (typeof Calendar !== 'undefined') {
      await renderReminders();
    } else {
      window.addEventListener('notePlanBridgeReady', function() {
        renderReminders();
      }, { once: true });
      setTimeout(function() {
        if (typeof Calendar !== 'undefined') renderReminders();
        else {
          document.getElementById('reminders').innerHTML =
            '<div class="empty">Calendar API not available</div>';
          document.getElementById('upcomingReminders').textContent = '—';
          document.getElementById('overdueCount').textContent = '—';
        }
      }, 2500);
    }
  }

  // Called by the plugin via runJavaScript to update data without reloading the page
  function updateContacts(newContacts, newReminderList) {
    CONTACTS = newContacts;
    if (newReminderList !== undefined) REMINDER_LIST = newReminderList;
    buildCategoryFilters();
    renderContacts();
    renderReminders();
  }

  window.addEventListener('load', init);
</script>
</body>
</html>`;
}