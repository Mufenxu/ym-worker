addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
  
  // 定时任务（请在 Worker 后台配置 Cron Trigger）
  addEventListener('scheduled', event => {
    event.waitUntil(handleScheduled());
  });
  
  // KV 存储 key
  const DOMAIN_KEY = "domains";
  
  // KV 读写辅助函数（确保在 Worker 环境中绑定 KV 命名空间 DOMAIN_DB）
  async function getDomains() {
    const data = await DOMAIN_DB.get(DOMAIN_KEY);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch(e) {
      return [];
    }
  }
  async function saveDomains(domains) {
    await DOMAIN_DB.put(DOMAIN_KEY, JSON.stringify(domains));
  }
  
  // 管理员账号（示例用，生产环境请加强安全措施）
  const ADMIN_USERNAME = "ADMIN_USERNAME";
  const ADMIN_PASSWORD = "ADMIN_PASSWORD";
  
  // Telegram 通知（请替换为你自己的 Bot Token 和 Chat ID）
  const TELEGRAM_BOT_TOKEN = "TELEGRAM_BOT_TOKEN";
  const TELEGRAM_CHAT_ID = "TELEGRAM_CHAT_ID";
  
  // 简单的 Cookie 认证检测
  function isAuthenticated(request) {
    let cookie = request.headers.get('Cookie') || "";
    return cookie.includes("session=valid");
  }
  
  async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      return handleAPI(request, url);
    }
    return new Response(getHTMLPage(), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
  
  async function handleAPI(request, url) {
    const path = url.pathname;
    const method = request.method;
    
    // 登录接口（设置10分钟后自动退出）
    if (path === "/api/login" && method === "POST") {
      let reqBody = await request.json();
      const { username, password } = reqBody;
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "session=valid; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600"
          }
        });
      } else {
        return new Response(JSON.stringify({ success: false, message: "凭证错误" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // 登出接口
    if (path === "/api/logout" && method === "POST") {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        }
      });
    }
    
    // 后续接口要求认证
    if (!isAuthenticated(request)) {
      return new Response(JSON.stringify({ success: false, message: "未授权" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // 获取所有域名数据
    if (path === "/api/domains" && method === "GET") {
      let domains = await getDomains();
      return new Response(JSON.stringify({ success: true, data: domains }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // 添加新域名
    if (path === "/api/domains" && method === "POST") {
      let reqBody = await request.json();
      let domains = await getDomains();
      let newId = domains.length ? Math.max(...domains.map(d => d.id)) + 1 : 1;
      let newDomain = {
        id: newId,
        domain: reqBody.domain || "",
        registrarName: reqBody.registrarName || "",
        registrarUrl: reqBody.registrarUrl || "",
        email: reqBody.email || "",
        password: reqBody.password || "",
        usage: reqBody.usage || "",
        registrationTime: reqBody.registrationTime || "",
        expirationTime: reqBody.expirationTime || ""
      };
      domains.push(newDomain);
      await saveDomains(domains);
      return new Response(JSON.stringify({ success: true, data: newDomain }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // 获取某个域名详情
    if (path.startsWith("/api/domains/") && method === "GET") {
      let id = parseInt(path.split("/").pop());
      let domains = await getDomains();
      let domainItem = domains.find(d => d.id === id);
      if (domainItem) {
        return new Response(JSON.stringify({ success: true, data: domainItem }), {
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ success: false, message: "域名未找到" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // 编辑域名
    if (path.startsWith("/api/domains/") && method === "PUT") {
      let id = parseInt(path.split("/").pop());
      let reqBody = await request.json();
      let domains = await getDomains();
      let index = domains.findIndex(d => d.id === id);
      if (index > -1) {
        domains[index] = { ...domains[index], ...reqBody };
        await saveDomains(domains);
        return new Response(JSON.stringify({ success: true, data: domains[index] }), {
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ success: false, message: "域名未找到" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    // 删除域名
    if (path.startsWith("/api/domains/") && method === "DELETE") {
      let id = parseInt(path.split("/").pop());
      let domains = await getDomains();
      let index = domains.findIndex(d => d.id === id);
      if (index > -1) {
        let removed = domains.splice(index, 1);
        await saveDomains(domains);
        return new Response(JSON.stringify({ success: true, data: removed[0] }), {
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ success: false, message: "域名未找到" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    return new Response(JSON.stringify({ success: false, message: "未找到" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // 发送 Telegram 消息函数（每次检测到不足一周时发送通知，通知中包含官网链接）
  async function sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(text)}`;
    await fetch(url);
  }
  
  // 定时任务：检测各域名到期情况，每次检测到不足一周（且未过期）时发送通知
  async function handleScheduled() {
    const now = new Date();
    let domains = await getDomains();
    for (let domain of domains) {
      if (domain.expirationTime) {
        const exp = new Date(domain.expirationTime);
        const diffDays = (exp - now) / (1000 * 60 * 60 * 24);
        if (diffDays <= 7 && diffDays >= 0) {
          const message = `提醒：域名 ${domain.domain} 将在 ${Math.ceil(diffDays)} 天后到期，详情请访问 ${domain.registrarUrl}`;
          await sendTelegramMessage(message);
        }
      }
    }
  }
  
  function getHTMLPage() {
    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>域名监控面板</title>
    <link rel="icon" type="image/png" href="https://cdn-icons-png.flaticon.com/512/220/220236.png">
    <style>
      /* 全局背景：统一使用一张精选简约风景照片 */
      *, *:before, *:after { box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        margin: 0;
        padding: 0;
        background: url('https://tc.xuo.me/uploads/4b2d4414e9894066bab62c5e70a81a5b.jpg') no-repeat center center fixed;
        background-size: cover;
      }
      /* 全屏登录界面 */
      .login-container {
        position: fixed;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
        padding: 10px;
      }
      .login-card {
        background: rgba(255,255,255,0.98);
        padding: 30px;
        border-radius: 10px;
        box-shadow: 0 6px 16px rgba(0,0,0,0.3);
        width: 100%;
        max-width: 400px;
        text-align: center;
      }
      .login-card h2 {
        margin-top: 0;
        margin-bottom: 20px;
        color: #333;
      }
      .login-card input[type="text"],
      .login-card input[type="password"] {
        width: 100%;
        padding: 12px 15px;
        margin: 10px 0;
        border: 1px solid #bbb;
        border-radius: 6px;
        transition: border-color 0.2s;
        font-size: 16px;
      }
      .login-card input:focus {
        border-color: #4a90e2;
        outline: none;
      }
      .login-card button {
        width: 100%;
        padding: 12px;
        background: linear-gradient(145deg, #4a90e2, #357ABD);
        border: none;
        border-radius: 6px;
        color: #fff;
        font-size: 18px;
        cursor: pointer;
        box-shadow: 4px 4px 8px #ccc, -4px -4px 8px #fff;
        transition: transform 0.1s;
      }
      .login-card button:active {
        transform: translateY(2px);
      }
      /* 仪表盘容器 */
      .dashboard-container {
        display: none;
        padding: 20px;
        background: rgba(255,255,255,0.98);
        max-width: 960px;
        margin: 40px auto;
        border-radius: 10px;
        box-shadow: 0 6px 16px rgba(0,0,0,0.2);
        overflow-x: auto;
      }
      header {
        text-align: center;
        margin-bottom: 20px;
      }
      header h1 {
        margin: 0;
        font-size: 28px;
        color: #333;
      }
      /* 表格：所有信息一行显示，提供水平滚动 */
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 20px;
      }
      th, td {
        padding: 10px;
        text-align: left;
        border-bottom: 1px solid #ddd;
        white-space: nowrap;
      }
      th { background: #f0f4f8; }
      /* 在到期时间后增加剩余天数列 */
      th:nth-child(5) { /* 到期时间所在列 */
        /* 保持原样 */
      }
      /* 操作列：所有按钮居中显示 */
      td:last-child {
        text-align: center;
      }
      .btn {
        padding: 8px 12px;
        margin: 2px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        background: linear-gradient(145deg, #ffffff, #e6e6e6);
        box-shadow: 3px 3px 6px #ccc, -3px -3px 6px #fff;
        transition: transform 0.1s;
      }
      .btn:active { transform: translateY(2px); }
      .btn-primary { background: linear-gradient(145deg, #4a90e2, #357ABD); color: #fff; }
      .btn-danger { background: linear-gradient(145deg, #e94b35, #d83a2c); color: #fff; }
      .btn-secondary { background: linear-gradient(145deg, #7b8a8b, #6a7a7a); color: #fff; }
      /* 进度条样式 */
      .progress-container {
        width: 100%;
        background: #ddd;
        border-radius: 4px;
        overflow: hidden;
      }
      .progress-bar {
        height: 20px;
        background: linear-gradient(145deg, #4a90e2, #357ABD);
        text-align: center;
        color: #fff;
        line-height: 20px;
      }
      /* 弹窗统一样式，包含退出按钮 */
      .modal {
        display: none;
        position: fixed;
        z-index: 3000;
        left: 0; top: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0,0,0,0.5);
        align-items: center;
        justify-content: center;
        padding: 10px;
      }
      .modal-content {
        background: #fff;
        padding: 20px 30px;
        border-radius: 10px;
        width: 100%;
        max-width: 500px;
        max-height: 90vh;
        overflow-y: auto;
        position: relative;
        box-shadow: 0 6px 12px rgba(0,0,0,0.2);
      }
      .modal-content .close {
        position: absolute;
        right: 15px;
        top: 10px;
        cursor: pointer;
        font-size: 22px;
      }
      .modal-content .exit-btn {
        margin-top: 20px;
        width: 100%;
        padding: 10px;
        background: #7b8a8b;
        border: none;
        border-radius: 6px;
        color: #fff;
        font-size: 16px;
        cursor: pointer;
      }
      /* 添加/编辑界面输入框样式优化 */
      .modal-content input[type="text"],
      .modal-content input[type="email"],
      .modal-content input[type="date"],
      .modal-content input[type="password"] {
        width: 100%;
        padding: 12px 15px;
        margin: 8px 0 16px;
        border: 1px solid #bbb;
        border-radius: 6px;
        transition: border-color 0.2s;
        font-size: 16px;
      }
      .modal-content input:focus {
        border-color: #4a90e2;
        outline: none;
      }
      .modal-content label {
        font-weight: bold;
        color: #333;
      }
      /* 移动端优化：保持桌面风格 */
      @media (max-width: 600px) {
        .dashboard-container { margin: 20px 10px; padding: 15px; }
        table, th, td { font-size: 14px; }
        .login-card, .modal-content { padding: 20px; }
      }
    </style>
  </head>
  <body>
    <!-- 全屏登录界面 -->
    <div id="loginSection" class="login-container">
      <div class="login-card">
        <h2>登录</h2>
        <input type="text" id="username" placeholder="用户名" required>
        <input type="password" id="password" placeholder="密码" required>
        <button id="loginBtn">登录</button>
      </div>
    </div>
    
    <!-- 仪表盘界面 -->
    <div id="dashboardSection" class="dashboard-container">
      <header>
        <h1>域名监控面板</h1>
        <button id="logoutBtn" class="btn btn-secondary">登出</button>
        <button id="addDomainBtn" class="btn btn-primary">添加域名</button>
      </header>
      <div style="overflow-x:auto;">
        <table id="domainTable">
          <thead>
            <tr>
              <th>域名</th>
              <th>状态</th>
              <th>注册商</th>
              <th>注册时间</th>
              <th>到期时间</th>
              <th>剩余天数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    
    <!-- 域名添加/编辑弹窗 -->
    <div id="domainModal" class="modal">
      <div class="modal-content">
        <span class="close" id="domainClose">&times;</span>
        <h2 id="domainModalTitle">添加/编辑域名</h2>
        <form id="domainForm">
          <input type="hidden" id="domainId">
          <div>
            <label>域名：</label>
            <input type="text" id="domainName" required>
          </div>
          <div>
            <label>注册商名称：</label>
            <input type="text" id="domainRegistrarName" required>
          </div>
          <div>
            <label>注册商链接：</label>
            <input type="text" id="domainRegistrarUrl" required>
          </div>
          <div>
            <label>邮箱：</label>
            <input type="email" id="domainEmail" required>
          </div>
          <div>
            <label>密码：</label>
            <input type="text" id="domainPassword" required>
          </div>
          <div>
            <label>使用：</label>
            <input type="text" id="domainUsage" required>
          </div>
          <div>
            <label>注册时间：</label>
            <input type="date" id="domainRegTime" required>
          </div>
          <div>
            <label>到期时间：</label>
            <input type="date" id="domainExpTime" required>
          </div>
          <button type="submit" class="btn btn-primary">保存</button>
        </form>
        <button class="exit-btn" id="domainExitBtn">退出</button>
      </div>
    </div>
    
    <!-- 详情弹窗 -->
    <div id="detailModal" class="modal">
      <div class="modal-content">
        <span class="close" id="detailClose">&times;</span>
        <h2>详细信息</h2>
        <div id="detailContent"></div>
        <button class="exit-btn" id="detailExitBtn">退出</button>
      </div>
    </div>
    
    <script>
      // 判断 Cookie 是否存在，决定显示登录界面或仪表盘
      if(document.cookie.includes("session=valid")){
        document.getElementById("loginSection").style.display = "none";
        document.getElementById("dashboardSection").style.display = "block";
        loadDomains();
      }
      
      // 登录逻辑
      document.getElementById("loginBtn").addEventListener("click", async () => {
        const username = document.getElementById("username").value;
        const password = document.getElementById("password").value;
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if(data.success){
          document.getElementById("loginSection").style.display = "none";
          document.getElementById("dashboardSection").style.display = "block";
          loadDomains();
        } else {
          alert("登录失败：" + data.message);
        }
      });
      
      // 登出逻辑
      document.getElementById("logoutBtn").addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST" });
        location.reload();
      });
      
      // 域名添加/编辑弹窗逻辑
      const domainModal = document.getElementById("domainModal");
      const domainForm = document.getElementById("domainForm");
      document.getElementById("addDomainBtn").addEventListener("click", () => {
        document.getElementById("domainModalTitle").innerText = "添加域名";
        document.getElementById("domainId").value = "";
        domainForm.reset();
        domainModal.style.display = "flex";
      });
      document.getElementById("domainClose").addEventListener("click", () => { domainModal.style.display = "none"; });
      document.getElementById("domainExitBtn").addEventListener("click", () => { domainModal.style.display = "none"; });
      
      domainForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = document.getElementById("domainId").value;
        const payload = {
          domain: document.getElementById("domainName").value,
          registrarName: document.getElementById("domainRegistrarName").value,
          registrarUrl: document.getElementById("domainRegistrarUrl").value,
          email: document.getElementById("domainEmail").value,
          password: document.getElementById("domainPassword").value,
          usage: document.getElementById("domainUsage").value,
          registrationTime: document.getElementById("domainRegTime").value,
          expirationTime: document.getElementById("domainExpTime").value
        };
        let res;
        if(id){
          res = await fetch("/api/domains/" + id, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        } else {
          res = await fetch("/api/domains", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        }
        const data = await res.json();
        if(data.success){
          domainModal.style.display = "none";
          loadDomains();
        } else {
          alert("操作失败：" + data.message);
        }
      });
      
      // 加载域名列表，计算使用进度，并新增剩余天数列
      async function loadDomains() {
        const res = await fetch("/api/domains");
        const result = await res.json();
        if(result.success){
          const tbody = document.querySelector("#domainTable tbody");
          tbody.innerHTML = "";
          result.data.forEach(item => {
            const now = new Date();
            const regDate = new Date(item.registrationTime);
            const expDate = new Date(item.expirationTime);
            let progress = 0;
            if(now < regDate) {
              progress = 0;
            } else if(now > expDate) {
              progress = 100;
            } else {
              progress = ((now - regDate) / (expDate - regDate)) * 100;
            }
            let diff = expDate - now;
            let statusText = "正常";
            let statusColor = "green";
            if(diff < 0) {
              statusText = "已过期";
              statusColor = "red";
            } else if(diff < 7 * 24 * 60 * 60 * 1000) {
              statusText = "即将到期";
              statusColor = "orange";
            }
            let remainingDays = Math.ceil(diff / (1000 * 60 * 60 * 24));
            if(remainingDays < 0) remainingDays = 0;
            
            const tr = document.createElement("tr");
            tr.innerHTML = \`
              <td>\${item.domain}</td>
              <td><span style="background-color: \${statusColor}; padding: 4px 8px; border-radius: 4px; color: #fff;">\${statusText}</span></td>
              <td><a href="\${item.registrarUrl.startsWith("http") ? item.registrarUrl : "https://" + item.registrarUrl}" target="_blank">\${item.registrarName}</a></td>
              <td>\${item.registrationTime}</td>
              <td>\${item.expirationTime}</td>
              <td>\${remainingDays}</td>
              <td>
                <div style="text-align: center;">
                  <button class="btn btn-secondary" onclick="viewDetail(\${item.id})">详情</button>
                  <button class="btn btn-primary" onclick="editDomain(\${item.id})">编辑</button>
                  <button class="btn btn-danger" onclick="deleteDomain(\${item.id})">删除</button>
                </div>
              </td>
            \`;
            tbody.appendChild(tr);
          });
        }
      }
      
      // 详情弹窗逻辑：移除注册时间和到期时间，每行后放置复制按钮
      const detailModal = document.getElementById("detailModal");
      document.getElementById("detailClose").addEventListener("click", () => { detailModal.style.display = "none"; });
      document.getElementById("detailExitBtn").addEventListener("click", () => { detailModal.style.display = "none"; });
      
      async function viewDetail(id) {
        const res = await fetch("/api/domains/" + id);
        const result = await res.json();
        if(result.success){
          const d = result.data;
          document.getElementById("detailContent").innerHTML = \`
            <p><strong>域名：</strong>\${d.domain} <button class="copy-btn" onclick="copyText('\${d.domain}')">复制</button></p>
            <p><strong>注册商名称：</strong>\${d.registrarName} <button class="copy-btn" onclick="copyText('\${d.registrarName}')">复制</button></p>
            <p><strong>注册商链接：</strong>\${d.registrarUrl} <button class="copy-btn" onclick="copyText('\${d.registrarUrl}')">复制</button></p>
            <p><strong>邮箱：</strong>\${d.email} <button class="copy-btn" onclick="copyText('\${d.email}')">复制</button></p>
            <p><strong>密码：</strong>\${d.password} <button class="copy-btn" onclick="copyText('\${d.password}')">复制</button></p>
            <p><strong>使用：</strong>\${d.usage} <button class="copy-btn" onclick="copyText('\${d.usage}')">复制</button></p>
          \`;
          detailModal.style.display = "flex";
        }
      }
      
      async function editDomain(id) {
        const res = await fetch("/api/domains/" + id);
        const result = await res.json();
        if(result.success){
          const d = result.data;
          document.getElementById("domainModalTitle").innerText = "编辑域名";
          document.getElementById("domainId").value = d.id;
          document.getElementById("domainName").value = d.domain;
          document.getElementById("domainRegistrarName").value = d.registrarName;
          document.getElementById("domainRegistrarUrl").value = d.registrarUrl;
          document.getElementById("domainEmail").value = d.email;
          document.getElementById("domainPassword").value = d.password;
          document.getElementById("domainUsage").value = d.usage;
          document.getElementById("domainRegTime").value = d.registrationTime;
          document.getElementById("domainExpTime").value = d.expirationTime;
          domainModal.style.display = "flex";
        }
      }
      
      async function deleteDomain(id) {
        if(confirm("确定要删除该域名吗？")){
          const res = await fetch("/api/domains/" + id, { method: "DELETE" });
          const result = await res.json();
          if(result.success){
            loadDomains();
          } else {
            alert("删除失败：" + result.message);
          }
        }
      }
      
      function copyText(text) {
        navigator.clipboard.writeText(text).then(() => {
          alert("已复制：" + text);
        });
      }
    </script>
  </body>
  </html>
    `;
  }
  
